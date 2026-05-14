import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AppContext } from '../index.js';
import { authenticateToken, AuthRequest, requireAnyRole } from '../middleware/auth.js';
import { checkSubmissionAccess, denyIfNeeded } from '../middleware/submission-auth.js';
import {
  CreateSelectionRequestSchema,
  CreateCommentRequestSchema,
  CreateRatingRequestSchema,
  Selection,
  Comment,
  Rating
} from '../types/annotation.js';

export function createAnnotationRoutes(context: AppContext): Router {
  const router = Router();

  // ============================================================================
  // ANNOTATION PERMISSIONS MODEL (as of 2025-11-21)
  // ============================================================================
  // 
  // SELECTIONS, TAGS, COMMENTS: Open to ANY authenticated user (including contributors)
  //   - Rationale: These are collaborative contributions, not formal evaluations
  //   - Tags use voting system, so multiple users can apply same tag
  //   - Comments are community discussion
  //   - Selections are the foundation for both
  // 
  // RATINGS: Restricted to 'rater', 'expert', 'researcher', 'agent', 'admin'
  //   - Rationale: Ratings are formal numerical evaluations against criteria
  //   - Requires understanding of rating systems and criteria
  //   - "Rater" role exists specifically for this purpose
  // 
  // This model may be refined based on usage patterns and manager guidance.
  // If changing permissions, update this comment to explain the new model.
  // ============================================================================

  // Create selection (open to all authenticated users WHO CAN ACCESS THE
  // SUBMISSION). Previously: any authenticated user who knew a submission
  // UUID could create selections on private/researcher-only submissions
  // they couldn't actually see.
  router.post('/selections', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const data = CreateSelectionRequestSchema.parse(req.body);

      const access = await checkSubmissionAccess(context, req, data.submission_id, 'annotate');
      if (denyIfNeeded(res, access)) return;

      const selection: Selection = {
        id: uuidv4(),
        submission_id: data.submission_id,
        created_by: req.userId!,
        start_message_id: data.start_message_id,
        start_offset: data.start_offset,
        end_message_id: data.end_message_id,
        end_offset: data.end_offset,
        label: data.label,
        annotation_tags: [],
        created_at: new Date()
      };

      context.annotationDb.createSelection(selection);

      res.status(201).json(selection);
    } catch (error: any) {
      if (error.name === 'ZodError') {
        res.status(400).json({ error: 'Invalid request', details: error.errors });
      } else {
        console.error('Create selection error:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // Get selections for submission (read access enforced — previously
  // anyone could list selections, with tag attributions, for any submission
  // ID including private ones).
  router.get('/selections/submission/:submissionId', async (req, res) => {
    try {
      const access = await checkSubmissionAccess(context, req, req.params.submissionId, 'read');
      if (denyIfNeeded(res, access)) return;

      const selections = context.annotationDb.getSelectionsBySubmission(req.params.submissionId);

      const selectionsWithAttributions = selections.map(sel => ({
        ...sel,
        tag_attributions: context.annotationDb.getTagAttributions(sel.id)
      }));

      res.json({ selections: selectionsWithAttributions });
    } catch (error) {
      console.error('Get selections error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Create comment (open to all authenticated users WHO CAN ANNOTATE THE
  // PARENT SUBMISSION). Comments target a selection, so we resolve the
  // selection's submission and authorize against that.
  router.post('/comments', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const data = CreateCommentRequestSchema.parse(req.body);

      const selection = context.annotationDb.getSelection(data.selection_id);
      if (!selection) {
        // Non-enumerating: same response as "you can't comment here". An
        // attacker probing selection IDs gets identical responses for
        // "doesn't exist" and "exists but you can't reach the submission".
        res.status(404).json({ error: 'Selection not found' });
        return;
      }
      const access = await checkSubmissionAccess(context, req, selection.submission_id, 'annotate');
      if (denyIfNeeded(res, access)) return;

      const comment: Comment = {
        id: uuidv4(),
        selection_id: data.selection_id,
        author_id: req.userId!,
        parent_id: data.parent_id,
        content: data.content,
        created_at: new Date()
      };

      context.annotationDb.createComment(comment);

      res.status(201).json(comment);
    } catch (error: any) {
      if (error.name === 'ZodError') {
        res.status(400).json({ error: 'Invalid request', details: error.errors });
      } else {
        console.error('Create comment error:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // Get comments for selection. Resolves the selection's submission and
  // applies the read policy. We return an empty `comments` list rather than
  // distinct 403/404 responses so an attacker probing selection UUIDs can't
  // tell whether a selection exists and is restricted vs doesn't exist at
  // all. Legitimate callers see the data they're entitled to.
  router.get('/comments/selection/:selectionId', async (req, res) => {
    try {
      const selection = context.annotationDb.getSelection(req.params.selectionId);
      if (!selection) {
        res.json({ comments: [] });
        return;
      }
      const access = await checkSubmissionAccess(context, req, selection.submission_id, 'read');
      if (!access.ok) {
        res.json({ comments: [] });
        return;
      }
      const comments = context.annotationDb.getCommentsBySelection(req.params.selectionId);
      res.json({ comments });
    } catch (error) {
      console.error('Get comments error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Create rating (rater+ role gate AND submission-scoped access check).
  // The role gate alone wasn't enough: a `rater` could previously POST a
  // rating for any submission UUID, including private ones they couldn't
  // read. The role gate stays for the "formal evaluation requires
  // evaluator role" intent; the submission check stays for the visibility
  // boundary.
  router.post('/ratings', authenticateToken, requireAnyRole(['rater', 'expert', 'researcher', 'agent', 'admin']), async (req: AuthRequest, res) => {
    try {
      const data = CreateRatingRequestSchema.parse(req.body);

      const access = await checkSubmissionAccess(context, req, data.submission_id, 'annotate');
      if (denyIfNeeded(res, access)) return;

      const rating: Rating = {
        id: uuidv4(),
        submission_id: data.submission_id,
        rater_id: req.userId!,
        criterion_id: data.criterion_id,
        score: data.score,
        created_at: new Date()
      };

      // Store in SQLite
      context.annotationDb.createRating(rating);

      res.status(201).json(rating);
    } catch (error: any) {
      if (error.name === 'ZodError') {
        res.status(400).json({ error: 'Invalid request', details: error.errors });
      } else {
        console.error('Create rating error:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // Get ratings for submission (read access enforced).
  router.get('/ratings/submission/:submissionId', async (req, res) => {
    try {
      const access = await checkSubmissionAccess(context, req, req.params.submissionId, 'read');
      if (denyIfNeeded(res, access)) return;

      const ratings = context.annotationDb.getRatingsBySubmission(req.params.submissionId);
      res.json({ ratings });
    } catch (error) {
      console.error('Get ratings error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Delete selection (collaborative deletion rules + submission read access).
  router.delete('/selections/:selectionId', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const selection = context.annotationDb.getSelection(req.params.selectionId);
      if (!selection) {
        res.status(404).json({ error: 'Selection not found' });
        return;
      }
      // If you can no longer reach the submission, you can't mutate its
      // annotations — even ones you originally created. This closes the
      // legacy path where annotations may have been created on submissions
      // that later became restricted, or via the visibility bypass that
      // existed before this PR.
      const access = await checkSubmissionAccess(context, req, selection.submission_id, 'read');
      if (denyIfNeeded(res, access)) return;

      const user = await context.userStore.getUserById(req.userId!);
      
      // Admins and researchers can always delete
      if (user?.roles.includes('admin') || user?.roles.includes('researcher')) {
        context.annotationDb.deleteSelection(req.params.selectionId);
        res.status(200).json({ success: true });
        return;
      }

      // Regular users: check collaborative deletion rules
      const { canDelete, reason } = context.annotationDb.canDeleteSelection(req.params.selectionId, req.userId!);
      
      if (!canDelete) {
        res.status(403).json({ error: reason || 'Not authorized to delete this selection' });
        return;
      }

      context.annotationDb.deleteSelection(req.params.selectionId);
      res.status(200).json({ success: true });
    } catch (error) {
      console.error('Delete selection error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Remove tag from selection (removes your vote only).
  router.delete('/selections/:selectionId/tags/:tagId', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const selection = context.annotationDb.getSelection(req.params.selectionId);
      if (!selection) {
        res.status(404).json({ error: 'Selection not found' });
        return;
      }
      const access = await checkSubmissionAccess(context, req, selection.submission_id, 'read');
      if (denyIfNeeded(res, access)) return;

      // Check if user has voted for this tag or is moderator
      const attributions = context.annotationDb.getTagAttributions(req.params.selectionId);
      const userVote = attributions.find(a => a.tag_id === req.params.tagId && a.tagged_by === req.userId);
      
      const user = await context.userStore.getUserById(req.userId!);
      const isModerator = user?.roles.includes('researcher') || user?.roles.includes('admin');
      
      if (!isModerator && !userVote) {
        res.status(403).json({ error: 'You have not voted for this tag' });
        return;
      }

      // Remove only this user's vote
      context.annotationDb.removeTag(req.params.selectionId, req.params.tagId, req.userId!);
      res.status(200).json({ success: true });
    } catch (error) {
      console.error('Remove tag error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Delete comment.
  router.delete('/comments/:commentId', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const comment = context.annotationDb.getComment(req.params.commentId);
      if (!comment) {
        res.status(404).json({ error: 'Comment not found' });
        return;
      }
      // Resolve selection → submission, then enforce read access on the
      // submission. A user who can't see the submission can't delete its
      // comments, even ones they wrote.
      const parentSelection = context.annotationDb.getSelection(comment.selection_id);
      if (parentSelection) {
        const access = await checkSubmissionAccess(context, req, parentSelection.submission_id, 'read');
        if (denyIfNeeded(res, access)) return;
      }

      const user = await context.userStore.getUserById(req.userId!);
      const canDelete = comment.author_id === req.userId! ||
                        user?.roles.includes('researcher') ||
                        user?.roles.includes('admin');

      if (!canDelete) {
        res.status(403).json({ error: 'Not authorized to delete this comment' });
        return;
      }

      context.annotationDb.deleteComment(req.params.commentId);
      res.status(200).json({ success: true });
    } catch (error) {
      console.error('Delete comment error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Update comment (author only + submission read access).
  router.patch('/comments/:commentId', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const comment = context.annotationDb.getComment(req.params.commentId);
      if (!comment) {
        res.status(404).json({ error: 'Comment not found' });
        return;
      }
      const parentSelection = context.annotationDb.getSelection(comment.selection_id);
      if (parentSelection) {
        const access = await checkSubmissionAccess(context, req, parentSelection.submission_id, 'read');
        if (denyIfNeeded(res, access)) return;
      }

      // Only the author can edit their comment
      if (comment.author_id !== req.userId!) {
        res.status(403).json({ error: 'Only the author can edit this comment' });
        return;
      }

      const { content } = req.body;
      if (!content || typeof content !== 'string' || !content.trim()) {
        res.status(400).json({ error: 'Content is required' });
        return;
      }

      const updatedComment = context.annotationDb.updateComment(req.params.commentId, content.trim());
      res.json(updatedComment);
    } catch (error) {
      console.error('Update comment error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Delete rating (deletes all ratings by this rater for this criterion).
  router.delete('/ratings/:ratingId', authenticateToken, async (req: AuthRequest, res) => {
    try {
      const rating = context.annotationDb.getRating(req.params.ratingId);
      if (!rating) {
        res.status(404).json({ error: 'Rating not found' });
        return;
      }
      const access = await checkSubmissionAccess(context, req, rating.submission_id, 'read');
      if (denyIfNeeded(res, access)) return;

      const user = await context.userStore.getUserById(req.userId!);
      const canDelete = rating.rater_id === req.userId! ||
                        user?.roles.includes('researcher') ||
                        user?.roles.includes('admin');

      if (!canDelete) {
        res.status(403).json({ error: 'Not authorized to delete this rating' });
        return;
      }

      context.annotationDb.deleteRating(req.params.ratingId);
      res.status(200).json({ success: true });
    } catch (error) {
      console.error('Delete rating error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

