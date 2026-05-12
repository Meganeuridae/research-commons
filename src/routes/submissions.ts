import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AppContext } from '../index.js';
import { authenticateToken, AuthRequest, parseAuthFromHeaders } from '../middleware/auth.js';
import { CreateSubmissionRequestSchema, UpdateSubmissionRequestSchema, Message } from '../types/submission.js';

export function createSubmissionRoutes(context: AppContext): Router {
  const router = Router();

  // List submissions
  router.get('/', async (req, res) => {
    try {
      const allSubmissions = await context.submissionStore.listSubmissions();

      const { userId, roles: userRoles } = parseAuthFromHeaders(req.headers.authorization);
      const isResearcher = userRoles.includes('researcher') || userRoles.includes('admin');
      
      // Filter by visibility
      const submissions = allSubmissions.filter(sub => {
        const visibility = sub.visibility || 'public'; // Default for legacy submissions
        
        // Public: everyone can see
        if (visibility === 'public') return true;
        
        // Unlisted: never appears in listings (accessible via direct link only)
        if (visibility === 'unlisted') return false;
        
        // Private: only owner and admins
        if (visibility === 'private') {
          return userId === sub.submitter_id || userRoles.includes('admin');
        }
        
        // Researcher: researchers, admins, and owner
        if (visibility === 'researcher') {
          return isResearcher || userId === sub.submitter_id;
        }
        
        return false;
      });
      
      // Enhance each submission with stats and submitter name
      const submissionsWithStats = await Promise.all(submissions.map(async sub => {
        try {
          // Get selections (annotations/tags)
          const selections = context.annotationDb.getSelectionsBySubmission(sub.id);
          const tagCount = new Set(
            selections.flatMap(s => s.annotation_tags || [])
          ).size;
          
          // Get comments
          const allComments = selections.flatMap(s => 
            context.annotationDb.getCommentsBySelection(s.id)
          );
          const commentCount = allComments.length;
          
          // Get ratings
          const ratings = context.annotationDb.getRatingsBySubmission(sub.id);
          
          // Get submitter name
          const submitter = await context.userStore.getUserById(sub.submitter_id);
          const submitterName = submitter?.name || 'Unknown';
          
          // Compute model_summary and participants_summary if not already set
          let enhancedMetadata = { ...sub.metadata };
          if (!enhancedMetadata.model_summary || !enhancedMetadata.participants_summary) {
            try {
              const messages = await context.submissionStore.getMessages(sub.id);
              
              // Extract unique participants
              const participantCounts = new Map<string, number>();
              const modelCounts = new Map<string, number>();
              
              for (const msg of messages) {
                // Count participants
                const name = msg.participant_name;
                participantCounts.set(name, (participantCounts.get(name) || 0) + 1);
                
                // Count models (from model_info if present)
                if (msg.model_info?.model_id) {
                  const model = msg.model_info.model_id;
                  modelCounts.set(model, (modelCounts.get(model) || 0) + 1);
                }
              }
              
              // Sort by message count, take top entries
              const sortedParticipants = [...participantCounts.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([name]) => name);
              
              const sortedModels = [...modelCounts.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([model, count]) => ({ model, count }));
              
              if (!enhancedMetadata.participants_summary && sortedParticipants.length > 0) {
                enhancedMetadata.participants_summary = sortedParticipants;
              }
              if (sortedModels.length > 0) {
                // Store both the list and the counts
                enhancedMetadata.model_summary = sortedModels.map(m => m.model);
                enhancedMetadata.model_counts = sortedModels;
              }
            } catch (msgErr) {
              // Ignore errors loading messages
            }
          }
          
          return {
            ...sub,
            metadata: enhancedMetadata,
            submitter_name: submitterName,
            stats: {
              tag_count: tagCount,
              comment_count: commentCount,
              rating_count: ratings.length
            }
          };
        } catch (err) {
          console.error('Error enhancing submission:', sub.id, err);
          return {
            ...sub,
            submitter_name: 'Unknown',
            stats: {
              tag_count: 0,
              comment_count: 0,
              rating_count: 0
            }
          };
        }
      }));
      
      res.json({ submissions: submissionsWithStats });
    } catch (error) {
      console.error('List submissions error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Create submission
  router.post('/', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const data = CreateSubmissionRequestSchema.parse(req.body);
      const tempSubmissionId = uuidv4();
      
      // Convert request messages to full Message objects
      const messages: Message[] = data.messages.map(msg => ({
        ...msg,
        id: msg.id || uuidv4(),
        submission_id: tempSubmissionId,
        timestamp: msg.timestamp || new Date()
      }));

      // Create submission
      const submission = await context.submissionStore.createSubmission(
        req.userId!,
        data.title,
        data.source_type,
        messages,
        data.metadata as any,
        data.arc_conversation_id ? {
          arc_conversation_id: data.arc_conversation_id
          // TODO: Fetch certification from ARC API
        } : undefined,
        data.visibility || 'researcher',
        data.submission_type || 'conversation'
      );

      // Don't attach anything at creation - will be dynamically looked up from topics
      // Only public ontologies/ranking systems get attached (for submissions without topics)
      const topicTags = (data.metadata as any)?.tags || [];
      
      if (topicTags.length === 0) {
        // No topics - attach all public systems as convenience
        const allOntologies = await context.ontologyStore.getAllOntologies();
        for (const ontology of allOntologies.filter(o => o.permissions === 'public')) {
          try {
            const { v4: uuidv4 } = await import('uuid');
            context.annotationDb.attachOntology({
              id: uuidv4(),
              submission_id: submission.id,
              ontology_id: ontology.id,
              attached_by: req.userId!,
              attached_at: new Date(),
              usage_permissions: 'anyone',
              is_default: false
            });
          } catch (err) {
            console.error('Failed to attach ontology:', ontology.name, err);
          }
        }

        const allRankingSystems = await context.rankingStore.getAllRankingSystems();
        for (const system of allRankingSystems.filter(s => s.permissions === 'public')) {
          try {
            const { v4: uuidv4 } = await import('uuid');
            context.annotationDb.attachRankingSystem({
              id: uuidv4(),
              submission_id: submission.id,
              ranking_system_id: system.id,
              attached_by: req.userId!,
              attached_at: new Date(),
              usage_permissions: 'anyone',
              is_from_topic: false
            });
          } catch (err) {
            console.error('Failed to attach ranking system:', system.name, err);
          }
        }
      }

      res.status(201).json(submission);
    } catch (error: any) {
      if (error.name === 'ZodError') {
        res.status(400).json({
          error: 'Invalid request',
          details: error.errors,
          message: 'Validation failed - check details for specific field errors'
        });
      } else if (error.message?.includes('tree')) {
        res.status(400).json({ error: error.message });
      } else {
        console.error('Create submission failed:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // Get submission
  router.get('/:submissionId', async (req, res) => {
    try {
      const submission = await context.submissionStore.getSubmission(req.params.submissionId);
      
      if (!submission) {
        res.status(404).json({ error: 'Submission not found' });
        return;
      }

      const { userId, roles: userRoles } = parseAuthFromHeaders(req.headers.authorization);
      const visibility = submission.visibility || 'public';
      const isResearcher = userRoles.includes('researcher') || userRoles.includes('admin');
      const isOwner = userId === submission.submitter_id;
      
      let hasAccess = false;
      
      if (visibility === 'public' || visibility === 'unlisted') {
        // Public and unlisted are accessible to anyone (unlisted just doesn't appear in listings)
        hasAccess = true;
      } else if (visibility === 'private') {
        // Private: only owner and admins
        hasAccess = isOwner || userRoles.includes('admin');
      } else if (visibility === 'researcher') {
        // Researcher: researchers, admins, and owner
        hasAccess = isResearcher || isOwner;
      }
      
      if (!hasAccess) {
        res.status(403).json({ error: 'You do not have access to this submission' });
        return;
      }

      res.json(submission);
    } catch (error) {
      console.error('Get submission error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Pin a message (set pinned_message_id in metadata)
  router.post('/:submissionId/pin/:messageId', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const submission = await context.submissionStore.getSubmission(req.params.submissionId);
      
      if (!submission) {
        res.status(404).json({ error: 'Submission not found' });
        return;
      }

      // Check permissions: owner, admin, or researcher can pin
      const user = await context.userStore.getUserById(req.userId!);
      const canPin = submission.submitter_id === req.userId! ||
                     user?.roles.includes('admin') ||
                     user?.roles.includes('researcher');
      
      if (!canPin) {
        res.status(403).json({ error: 'Only submission owner, researchers, and admins can pin messages' });
        return;
      }

      // Update metadata with pinned message ID
      const updatedSubmission = {
        ...submission,
        metadata: {
          ...submission.metadata,
          pinned_message_id: req.params.messageId
        }
      };

      await context.submissionStore.updateSubmission(
        req.params.submissionId,
        updatedSubmission
      );

      const result = await context.submissionStore.getSubmission(req.params.submissionId);
      res.json(result);
    } catch (error) {
      console.error('Pin message error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Unpin message (remove pinned_message_id from metadata)
  router.delete('/:submissionId/pin', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const submission = await context.submissionStore.getSubmission(req.params.submissionId);
      
      if (!submission) {
        res.status(404).json({ error: 'Submission not found' });
        return;
      }

      // Check permissions: owner, admin, or researcher can unpin
      const user = await context.userStore.getUserById(req.userId!);
      const canPin = submission.submitter_id === req.userId! ||
                     user?.roles.includes('admin') ||
                     user?.roles.includes('researcher');
      
      if (!canPin) {
        res.status(403).json({ error: 'Only submission owner, researchers, and admins can unpin messages' });
        return;
      }

      // pinned_message_id is .optional() in the schema, so delete is typesafe
      const updatedMetadata = { ...submission.metadata };
      delete updatedMetadata.pinned_message_id;

      const updatedSubmission = {
        ...submission,
        metadata: updatedMetadata
      };

      await context.submissionStore.updateSubmission(
        req.params.submissionId,
        updatedSubmission
      );

      const result = await context.submissionStore.getSubmission(req.params.submissionId);
      res.json(result);
    } catch (error) {
      console.error('Unpin message error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Update submission metadata
  router.patch('/:submissionId', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const submission = await context.submissionStore.getSubmission(req.params.submissionId);
      
      if (!submission) {
        res.status(404).json({ error: 'Submission not found' });
        return;
      }

      // Check permissions
      const user = await context.userStore.getUserById(req.userId!);
      const isOwner = submission.submitter_id === req.userId!;
      const isAdmin = user?.roles.includes('admin');
      const isResearcher = user?.roles.includes('researcher');
      
      const canEditMetadata = isOwner || isResearcher || isAdmin;
      const canEditVisibility = isOwner || isAdmin; // Only owner + admin can change visibility
      
      if (!canEditMetadata) {
        res.status(403).json({ error: 'Not authorized to edit this submission' });
        return;
      }

      // Strict allowlist for body fields; rejects mass-assignment attempts
      // like { submitter_id: ..., roles: ... }.
      const updates = UpdateSubmissionRequestSchema.parse(req.body);

      if (updates.visibility !== undefined && !canEditVisibility) {
        res.status(403).json({ error: 'Only the owner or admin can change visibility' });
        return;
      }

      if (updates.title !== undefined) submission.title = updates.title;
      if (updates.visibility !== undefined) submission.visibility = updates.visibility;
      if (updates.description !== undefined) submission.metadata.description = updates.description;
      if (updates.tags !== undefined) submission.metadata.tags = updates.tags;

      await context.submissionStore.updateSubmission(req.params.submissionId, submission);

      res.json(submission);
    } catch (error: any) {
      if (error.name === 'ZodError') {
        res.status(400).json({ error: 'Invalid request', details: error.errors });
        return;
      }
      console.error('Update submission error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Add reaction to message
  router.post('/:submissionId/messages/:messageId/reactions/:reactionType', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const { messageId, reactionType } = req.params;
      
      if (!['star', 'laugh', 'sparkles'].includes(reactionType)) {
        res.status(400).json({ error: 'Invalid reaction type' });
        return;
      }
      
      context.annotationDb.addReaction(messageId, req.userId!, reactionType as 'star' | 'laugh' | 'sparkles');
      
      const reactions = context.annotationDb.getReactionsByMessage(messageId);
      res.json({ reactions });
    } catch (error) {
      console.error('Add reaction error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Remove reaction from message
  router.delete('/:submissionId/messages/:messageId/reactions/:reactionType', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const { messageId, reactionType } = req.params;
      
      if (!['star', 'laugh', 'sparkles'].includes(reactionType)) {
        res.status(400).json({ error: 'Invalid reaction type' });
        return;
      }
      
      context.annotationDb.removeReaction(messageId, req.userId!, reactionType as 'star' | 'laugh' | 'sparkles');
      
      const reactions = context.annotationDb.getReactionsByMessage(messageId);
      res.json({ reactions });
    } catch (error) {
      console.error('Remove reaction error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get reactions for a message
  router.get('/:submissionId/messages/:messageId/reactions', async (req, res) => {
    try {
      const reactions = context.annotationDb.getReactionsByMessage(req.params.messageId);
      res.json({ reactions });
    } catch (error) {
      console.error('Get reactions error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get hidden messages for a submission (researchers/admins/owners only)
  router.get('/:submissionId/hidden-messages', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const submission = await context.submissionStore.getSubmission(req.params.submissionId);
      
      if (!submission) {
        res.status(404).json({ error: 'Submission not found' });
        return;
      }

      const user = await context.userStore.getUserById(req.userId!);
      const isResearcherOrAdmin = user?.roles.includes('researcher') || user?.roles.includes('admin');
      const isOwner = submission.submitter_id === req.userId;
      
      if (!isResearcherOrAdmin && !isOwner) {
        res.status(403).json({ error: 'Only researchers, admins, and submission owners can view hidden messages' });
        return;
      }
      
      const hiddenMessageIds = context.annotationDb.getHiddenMessagesBySubmission(req.params.submissionId);
      res.json({ hidden_message_ids: hiddenMessageIds });
    } catch (error) {
      console.error('Get hidden messages error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get submission messages (supports both authenticated and anonymous access)
  router.get('/:submissionId/messages', async (req, res) => {
    try {
      let messages = await context.submissionStore.getMessages(req.params.submissionId);
      
      // Get submission to check ownership
      const submission = await context.submissionStore.getSubmission(req.params.submissionId);
      
      if (messages.length === 0) {
        // Check if submission exists
        if (!submission) {
          res.status(404).json({ error: 'Submission not found' });
          return;
        }
      }

      // Filter hidden messages for non-privileged users (optional auth)
      const { userId, roles: userRoles } = parseAuthFromHeaders(req.headers.authorization);

      // Redact hidden messages for non-privileged users (not researchers/admins/owners)
      const isResearcherOrAdmin = userRoles.includes('researcher') || userRoles.includes('admin');
      const isOwner = submission && userId === submission.submitter_id;
      const canViewHidden = isResearcherOrAdmin || isOwner;

      const hiddenMessageIds = new Set(context.annotationDb.getHiddenMessagesBySubmission(req.params.submissionId));


      if (!canViewHidden && hiddenMessageIds.size > 0) {
        // Replace content of hidden messages with block characters
        messages = messages.map(msg => {
          if (hiddenMessageIds.has(msg.id)) {
            // Count total characters in all text blocks
            const totalChars = msg.content_blocks
              .filter(b => b.type === 'text')
              .reduce((sum, b) => sum + (b.text?.length || 0), 0);
            
            // Generate block text with realistic word patterns
            let blockedText = '';
            let currentWordLength = 0;
            const maxWordLength = 12; // Cap word length
            
            for (let i = 0; i < totalChars; i++) {
              // Create spaces at word boundaries or randomly (30% chance)
              const shouldSpace = currentWordLength >= maxWordLength || 
                                  (currentWordLength > 2 && Math.random() < 0.30);
              
              if (shouldSpace) {
                blockedText += ' ';
                currentWordLength = 0;
              } else {
                blockedText += '▓'; // Medium shade block (darker than █)
                currentWordLength++;
              }
            }
            
            // Replace with redacted content
            return {
              ...msg,
              content_blocks: [{
                type: 'text' as const,
                text: blockedText
              }],
              _isHidden: true
            };
          }
          return msg;
        });
      }

      res.json({ messages });
    } catch (error) {
      console.error('Get messages error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Hide a message (admin or owner only)
  router.post('/:submissionId/messages/:messageId/hide', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const submission = await context.submissionStore.getSubmission(req.params.submissionId);
      if (!submission) {
        res.status(404).json({ error: 'Submission not found' });
        return;
      }

      const user = await context.userStore.getUserById(req.userId!);
      const isAdmin = user?.roles.includes('admin');
      const isOwner = submission.submitter_id === req.userId;
      if (!isAdmin && !isOwner) {
        res.status(403).json({ error: 'Only admins and submission owners can hide messages' });
        return;
      }

      const { reason } = req.body;
      context.annotationDb.hideMessage(req.params.messageId, req.params.submissionId, req.userId!, reason);
      res.json({ success: true });
    } catch (error) {
      console.error('Hide message error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Unhide a message (admin or owner only)
  router.delete('/:submissionId/messages/:messageId/hide', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const submission = await context.submissionStore.getSubmission(req.params.submissionId);
      
      if (!submission) {
        res.status(404).json({ error: 'Submission not found' });
        return;
      }

      // Check if user is admin or submission owner
      const user = await context.userStore.getUserById(req.userId!);
      const isAdmin = user?.roles.includes('admin');
      const isOwner = submission.submitter_id === req.userId;
      
      if (!isAdmin && !isOwner) {
        res.status(403).json({ error: 'Only admins and submission owners can unhide messages' });
        return;
      }

      context.annotationDb.unhideMessage(req.params.messageId);
      
      res.json({ success: true });
    } catch (error) {
      console.error('Unhide message error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Hide all previous messages (current message + all with order < current.order)
  router.post('/:submissionId/messages/:messageId/hide-previous', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const submission = await context.submissionStore.getSubmission(req.params.submissionId);
      if (!submission) {
        res.status(404).json({ error: 'Submission not found' });
        return;
      }

      const user = await context.userStore.getUserById(req.userId!);
      const isAdmin = user?.roles.includes('admin');
      const isOwner = submission.submitter_id === req.userId;
      if (!isAdmin && !isOwner) {
        res.status(403).json({ error: 'Only admins and submission owners can hide messages' });
        return;
      }

      const messages = await context.submissionStore.getMessages(req.params.submissionId);
      const targetMessage = messages.find(m => m.id === req.params.messageId);
      if (!targetMessage) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }

      const messagesToHide = messages.filter(m => m.order <= targetMessage.order);
      const { reason } = req.body;
      let hiddenCount = 0;
      for (const message of messagesToHide) {
        try {
          context.annotationDb.hideMessage(message.id, req.params.submissionId, req.userId!, reason);
          hiddenCount++;
        } catch (err) {
          console.error('Failed to hide message:', message.id, err);
        }
      }

      res.json({
        success: true,
        hidden_count: hiddenCount,
        message_ids: messagesToHide.map(m => m.id)
      });
    } catch (error) {
      console.error('Hide previous messages error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Toggle hidden_from_models flag on a message (admin or owner only)
  router.post('/:submissionId/messages/:messageId/hidden-from-models', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const { submissionId, messageId } = req.params;
      const { hidden } = req.body; // boolean
      
      const submission = await context.submissionStore.getSubmission(submissionId);
      
      if (!submission) {
        res.status(404).json({ error: 'Submission not found' });
        return;
      }

      // Check if user is admin or submission owner
      const user = await context.userStore.getUserById(req.userId!);
      const isAdmin = user?.roles.includes('admin');
      const isOwner = submission.submitter_id === req.userId;
      
      if (!isAdmin && !isOwner) {
        res.status(403).json({ error: 'Only admins and submission owners can change message visibility' });
        return;
      }

      // Update the message
      await context.submissionStore.updateMessage(submissionId, messageId, {
        hidden_from_models: hidden === true ? true : undefined
      });
      
      res.json({ success: true, hidden_from_models: hidden });
    } catch (error) {
      console.error('Toggle hidden_from_models error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Toggle monospace display for a message
  router.post('/:submissionId/messages/:messageId/monospace', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const { submissionId, messageId } = req.params;
      const { monospace } = req.body; // boolean
      
      const submission = await context.submissionStore.getSubmission(submissionId);
      
      if (!submission) {
        res.status(404).json({ error: 'Submission not found' });
        return;
      }

      // Check if user is admin, researcher, or submission owner
      const user = await context.userStore.getUserById(req.userId!);
      const isAdmin = user?.roles.includes('admin');
      const isResearcher = user?.roles.includes('researcher');
      const isOwner = submission.submitter_id === req.userId;
      
      if (!isAdmin && !isResearcher && !isOwner) {
        res.status(403).json({ error: 'Only admins, researchers, and submission owners can change message display' });
        return;
      }

      // Get current message to update its metadata
      const messages = await context.submissionStore.getMessages(submissionId);
      const message = messages.find(m => m.id === messageId);
      
      if (!message) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }

      // Update the message metadata
      const updatedMetadata = { 
        ...(message.metadata || {}),
        monospace: monospace === true ? true : undefined
      };
      
      // Clean up undefined values
      if (!updatedMetadata.monospace) {
        delete updatedMetadata.monospace;
      }

      await context.submissionStore.updateMessage(submissionId, messageId, {
        metadata: Object.keys(updatedMetadata).length > 0 ? updatedMetadata : undefined
      });
      
      res.json({ success: true, monospace });
    } catch (error) {
      console.error('Toggle monospace error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get all selections for submission (with their tags, comments, ratings)
  router.get('/:submissionId/selections', async (req, res) => {
    try {
      const selections = context.annotationDb.getSelectionsBySubmission(req.params.submissionId);
      
      // Populate each selection with its tags
      const selectionsWithData = selections.map(sel => {
        const tags = context.annotationDb.getTagsForSelection(sel.id);
        return { ...sel, annotation_tags: tags };
      });
      
      res.json({ selections: selectionsWithData });
    } catch (error) {
      console.error('Get selections error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Delete submission (soft delete - mark as deleted)
  router.delete('/:submissionId', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const submission = await context.submissionStore.getSubmission(req.params.submissionId);
      
      if (!submission) {
        res.status(404).json({ error: 'Submission not found' });
        return;
      }

      const user = await context.userStore.getUserById(req.userId!);
      const canDelete = submission.submitter_id === req.userId! ||
                        user?.roles.includes('admin');

      if (!canDelete) {
        res.status(403).json({ error: 'Not authorized to delete this submission' });
        return;
      }

      await context.submissionStore.deleteSubmission(req.params.submissionId, req.userId!);
      res.status(200).json({ success: true });
    } catch (error) {
      console.error('Delete submission error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

