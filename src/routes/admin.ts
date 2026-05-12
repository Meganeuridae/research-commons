import { Router } from 'express';
import { AppContext } from '../index.js';
import { authenticateToken, AuthRequest, requireRole } from '../middleware/auth.js';

/**
 * Admin-only endpoints for user management
 */
export function createAdminRoutes(context: AppContext): Router {
  const router = Router();

  // Promote user to admin (admin-only)
  router.post('/promote/:userId', authenticateToken, requireRole('admin'), async (req: AuthRequest, res) => {
    try {
      const targetUserId = req.params.userId;
      const user = await context.userStore.getUserById(targetUserId);

      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      await context.userStore.addUserRole(targetUserId, 'admin');
      await context.userStore.addUserRole(targetUserId, 'researcher');

      await context.auditStore.record({
        action: 'admin.promote',
        actor_user_id: req.userId!,
        target_user_id: targetUserId,
        metadata: { granted_roles: ['admin', 'researcher'] },
      });

      res.json({
        success: true,
        message: `User ${user.name} promoted to admin`,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          roles: [...user.roles, 'admin', 'researcher']
        }
      });
    } catch (error) {
      console.error('Promote user error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // NOTE: The previous unauthenticated POST /bootstrap-admin endpoint has been
  // removed. On a fresh deploy with no admin yet, the first user to register
  // could call it and become admin (race-to-register attack). Admin creation
  // is now done via shell access:
  //   npm run admin:create               # interactive
  //   npm run admin:promote -- <email>   # promote an existing user

  // List all users (admin-only)
  router.get('/users', authenticateToken, requireRole('admin'), async (req: AuthRequest, res) => {
    try {
      const users = await context.userStore.getAllUsers();
      res.json({ users });
    } catch (error) {
      console.error('List users error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

