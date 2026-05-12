import dotenv from 'dotenv';
// Load .env BEFORE any other import reads from process.env. The order matters:
// ESM hoists imports, but dotenv.config() is a function call that runs in
// statement order, so this needs to come first.
dotenv.config();

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import { SubmissionStore } from './storage/submission-store.js';
import { AnnotationDatabase } from './database/db.js';
import { UserStore } from './services/user-store.js';
import { ResearchStore } from './services/research-store.js';
import { OntologyStore } from './services/ontology-store.js';
import { RankingStore } from './services/ranking-store.js';
import { ModelStore } from './services/model-store.js';
import { ParticipantMappingStore } from './services/participant-mapping-store.js';
import { AuditStore } from './services/audit-store.js';
import { assertJwtSecret, setAuthUserStore } from './middleware/auth.js';
import { createAuthRoutes } from './routes/auth.js';
import { createSubmissionRoutes } from './routes/submissions.js';
import { createSubmissionSystemsRoutes } from './routes/submission-systems.js';
import { createAnnotationRoutes } from './routes/annotations.js';
import { createResearchRoutes } from './routes/research.js';
import { createOntologyRoutes } from './routes/ontologies.js';
import { createRankingRoutes } from './routes/rankings.js';
import { createModelRoutes } from './routes/models.js';
import { createAdminRoutes } from './routes/admin.js';
import { createImportRoutes } from './routes/imports.js';
import { createDiscordPreviewRoutes } from './routes/discord-preview.js';
import { createOgMetaRoutes, createOgMiddleware } from './routes/og-meta.js';
import { EmailService } from './services/email-service.js';
import { seedDefaultsIfMissing } from './seeds/defaults.js';

// Fail fast on misconfiguration rather than waiting for the first request.
assertJwtSecret();

const PORT = process.env.PORT || 3020;
const DATABASE_PATH = process.env.DATABASE_PATH || './data/research.db';
const SUBMISSIONS_PATH = process.env.SUBMISSIONS_PATH || './data/submissions';
const DATA_PATH = process.env.DATA_PATH || './data';

// Discord import configuration (server-side) - must be set via environment variables
const DISCORD_API_URL = process.env.DISCORD_API_URL;
const DISCORD_API_TOKEN = process.env.DISCORD_API_TOKEN;

// Email configuration
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@resend.dev'; // resend.dev for testing
const APP_URL = process.env.APP_URL || 'http://localhost:5173';

export interface AppContext {
  submissionStore: SubmissionStore;
  annotationDb: AnnotationDatabase;
  userStore: UserStore;
  researchStore: ResearchStore;
  ontologyStore: OntologyStore;
  rankingStore: RankingStore;
  modelStore: ModelStore;
  participantMappingStore: ParticipantMappingStore;
  auditStore: AuditStore;
  discordConfig: {
    apiUrl: string | undefined;
    apiToken: string | undefined;
  };
  emailService: EmailService | null;
}

function parseAllowedOrigins(): string[] | undefined {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return undefined;
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

async function main() {
  const app = express();

  // Behind Railway's edge proxy. Trust one hop so the rate limiter and
  // any client-IP logging see the actual client IP, not the proxy.
  app.set('trust proxy', 1);

  // Standard security headers (CSP, X-Frame-Options, X-Content-Type-Options,
  // Referrer-Policy, etc.). We disable helmet's default Content-Security-Policy
  // because the SPA loads from / and the dev server uses inline scripts in
  // index.html; configure CSP explicitly later if/when we know the asset graph.
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }));

  // CORS: in production, restrict to an explicit allowlist (set via the
  // ALLOWED_ORIGINS env var as a comma-separated list, e.g.
  // "https://commons.animalabs.ai,https://staging.animalabs.ai"). In dev, fall
  // back to permissive CORS so localhost:5173 (vite) can hit localhost:3020.
  const allowedOrigins = parseAllowedOrigins();
  if (allowedOrigins && allowedOrigins.length > 0) {
    app.use(cors({
      origin: allowedOrigins,
      credentials: false,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization']
    }));
  } else {
    if (process.env.NODE_ENV === 'production') {
      console.warn('⚠️  ALLOWED_ORIGINS is not set; allowing all origins. Set it in production.');
    }
    app.use(cors());
  }
  app.use(compression()); // Gzip compress all responses
  app.use(express.json({ limit: '50mb' })); // Large submissions with images

  // Initialize stores
  console.log('Initializing stores...');
  
  const submissionStore = new SubmissionStore(SUBMISSIONS_PATH);
  const annotationDb = new AnnotationDatabase(DATABASE_PATH);
  const userStore = new UserStore(DATA_PATH);
  const researchStore = new ResearchStore(DATA_PATH);
  const ontologyStore = new OntologyStore(DATA_PATH);
  const rankingStore = new RankingStore(DATA_PATH);
  const modelStore = new ModelStore(DATA_PATH);
  const participantMappingStore = new ParticipantMappingStore(DATA_PATH);
  const auditStore = new AuditStore(DATA_PATH);

  await submissionStore.init();
  await userStore.init();
  // Wire userStore into the auth middleware so token-revocation timestamps
  // (password_changed_at, roles_updated_at) are checked on each request.
  setAuthUserStore(userStore);
  await researchStore.init();
  await ontologyStore.init();
  await rankingStore.init();
  await modelStore.init();
  await participantMappingStore.init();
  await auditStore.init();

  // Auto-create defaults if needed (idempotent — only seeds empty collections)
  await seedDefaultsIfMissing({ ontologyStore, rankingStore, modelStore, researchStore });

  // Initialize email service if configured
  const emailService = RESEND_API_KEY ? new EmailService({
    apiKey: RESEND_API_KEY,
    fromEmail: FROM_EMAIL,
    appName: 'Research Commons',
    appUrl: APP_URL
  }) : null;

  const context: AppContext = {
    submissionStore,
    annotationDb,
    userStore,
    researchStore,
    ontologyStore,
    rankingStore,
    modelStore,
    participantMappingStore,
    auditStore,
    discordConfig: {
      apiUrl: DISCORD_API_URL,
      apiToken: DISCORD_API_TOKEN
    },
    emailService
  };

  // Routes
  app.use('/api/auth', createAuthRoutes(context));
  app.use('/api/submissions', createSubmissionRoutes(context));
  app.use('/api/submission-systems', createSubmissionSystemsRoutes(context));
  app.use('/api/annotations', createAnnotationRoutes(context));
  app.use('/api/research', createResearchRoutes(context));
  app.use('/api/ontologies', createOntologyRoutes(context));
  app.use('/api/rankings', createRankingRoutes(context));
  app.use('/api/models', createModelRoutes(context));
  app.use('/api/admin', createAdminRoutes(context));
  app.use('/api/imports', createImportRoutes(context));
  app.use('/api/discord-preview', createDiscordPreviewRoutes(context));
  app.use('/api', createOgMetaRoutes(context));

  // OG meta middleware for social media crawlers (must be before SPA fallback)
  app.use(createOgMiddleware(context));

  // Serve frontend in production
  if (process.env.NODE_ENV === 'production') {
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    
    app.use(express.static(path.join(__dirname, '../frontend/dist')));
    
    // SPA fallback - serve index.html for all non-API routes
    app.get('*', (req, res) => {
      if (!req.path.startsWith('/api') && !req.path.startsWith('/health')) {
        res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
      }
    });
  }

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // Start server
  app.listen(PORT, () => {
    console.log(`✅ Research Commons running on port ${PORT}`);
    if (process.env.NODE_ENV === 'production') {
      console.log(`📦 Serving frontend from /frontend/dist`);
    }
    if (!DISCORD_API_URL || !DISCORD_API_TOKEN) {
      console.warn(`⚠️  Discord import disabled: DISCORD_API_URL and DISCORD_API_TOKEN must be set`);
    } else {
      console.log(`🎮 Discord import enabled`);
    }
    if (!RESEND_API_KEY) {
      console.warn(`⚠️  Email disabled: RESEND_API_KEY must be set for password reset`);
    } else {
      console.log(`📧 Email service enabled (from: ${FROM_EMAIL})`);
    }
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    await submissionStore.close();
    annotationDb.close();
    await userStore.close();
    await researchStore.close();
    await ontologyStore.close();
    await rankingStore.close();
    await modelStore.close();
    await participantMappingStore.close();
    await auditStore.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

