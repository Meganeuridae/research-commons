import type { Request, Response } from 'express';
import type { Submission } from '../types/submission.js';
import type { User } from '../types/research.js';
import type { SubmissionStore } from '../storage/submission-store.js';
import { parseAuthFromHeaders } from './auth.js';

/**
 * Three modes of submission-scoped action, each with progressively stronger
 * requirements:
 *
 *   read     – fetch submission content, metadata, attached systems, etc.
 *   annotate – add selections / comments / ratings / tag votes
 *              (collaborative; requires auth even on public submissions)
 *   modify   – change the submission itself, or attach/detach ontologies and
 *              ranking systems (configuration-level)
 *
 * Decision matrix (rows = visibility, columns = caller; cell shows which
 * modes are allowed):
 *
 *               anon | any-auth | researcher | admin | owner
 *   public       r   |   r,a    |   r,a,m    | r,a,m | r,a,m
 *   unlisted     r   |   r,a    |   r,a,m    | r,a,m | r,a,m
 *   researcher   –   |   –      |   r,a,m    | r,a,m | r,a,m
 *   private      –   |   –      |   –        | r,a,m | r,a,m
 *
 * Notes:
 * - "researcher" implies the `researcher` role; "admin" implies `admin`.
 *   Admin is granted via PR #1's promote flow.
 * - Ratings have an additional role gate (rater/expert/researcher/agent/admin)
 *   enforced separately by the route's middleware. This helper handles only
 *   the submission-scoped portion; the role gate is orthogonal.
 * - `owner` always wins regardless of role.
 */
export type AccessMode = 'read' | 'annotate' | 'modify';

export type AccessResult =
  | { ok: true; submission: Submission; userId?: string; roles: User['roles'] }
  | { ok: false; status: 403 | 404; error: string };

interface AccessContext {
  submissionStore: SubmissionStore;
}

/**
 * Central authorization decision for any submission-scoped route. Loads the
 * submission, parses optional auth from the request, and returns either the
 * resolved submission (so the caller can reuse it without a second DB hit)
 * or an HTTP status + error message to send back.
 *
 * Routes should use this helper as their FIRST step — before reading messages,
 * selections, attached ontologies, or anything else under the submission.
 * Previously, several routes treated a well-formed UUID as sufficient
 * authority and returned data the caller wasn't entitled to.
 */
export async function checkSubmissionAccess(
  context: AccessContext,
  req: Request,
  submissionId: string,
  mode: AccessMode
): Promise<AccessResult> {
  const submission = await context.submissionStore.getSubmission(submissionId);
  if (!submission) {
    return { ok: false, status: 404, error: 'Submission not found' };
  }

  const { userId, roles } = parseAuthFromHeaders(req.headers.authorization);
  const isOwner = !!userId && userId === submission.submitter_id;
  const isAdmin = roles.includes('admin');
  const isResearcher = roles.includes('researcher') || isAdmin;
  // Default to 'public' for legacy submissions written before the field existed.
  const visibility = submission.visibility || 'public';

  let readable: boolean;
  switch (visibility) {
    case 'public':
    case 'unlisted':
      readable = true;
      break;
    case 'researcher':
      readable = isOwner || isResearcher;
      break;
    case 'private':
      readable = isOwner || isAdmin;
      break;
    default:
      // Unknown visibility: fail closed. Better to break a legitimate but
      // mistyped value than to silently grant access.
      readable = false;
  }

  if (!readable) {
    return { ok: false, status: 403, error: 'You do not have access to this submission' };
  }

  if (mode === 'read') {
    return { ok: true, submission, userId, roles };
  }

  // annotate + modify both require authentication. Anonymous users that
  // passed the read gate (public/unlisted) still can't write.
  if (!userId) {
    return { ok: false, status: 403, error: 'Authentication required' };
  }

  if (mode === 'annotate') {
    return { ok: true, submission, userId, roles };
  }

  // mode === 'modify': owner, researcher, or admin. Researcher is included
  // so research-ops actions (attaching ontologies / ranking systems to a
  // submission) don't require contacting the owner for routine changes.
  const canModify = isOwner || isAdmin || roles.includes('researcher');
  if (!canModify) {
    return {
      ok: false,
      status: 403,
      error: 'Only the owner, a researcher, or an admin can modify this submission',
    };
  }
  return { ok: true, submission, userId, roles };
}

/**
 * Convenience: send the denial as an HTTP response and return true. Routes
 * can then early-return:
 *
 *   const access = await checkSubmissionAccess(context, req, id, 'read');
 *   if (denyIfNeeded(res, access)) return;
 *   const submission = access.submission;
 */
export function denyIfNeeded(res: Response, access: AccessResult): access is { ok: false; status: 403 | 404; error: string } {
  if (access.ok) return false;
  res.status(access.status).json({ error: access.error });
  return true;
}
