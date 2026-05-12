import { OntologyStore } from '../services/ontology-store.js';
import { RankingStore } from '../services/ranking-store.js';
import { ModelStore } from '../services/model-store.js';
import { ResearchStore } from '../services/research-store.js';

// Single source of truth for the defaults seeded on a fresh install. Both
// src/index.ts (auto-seed on first boot) and scripts/seed-defaults.ts call
// these. Edit here; the previous standalone create-default-*.ts scripts had
// drifted from these values — git history preserves their richer data.

export async function seedDefaultOntologies(store: OntologyStore): Promise<void> {
  await store.createOntology(
    'LLM Response Patterns',
    'Categorize types of model responses and communication strategies',
    'model-behavior',
    'public',
    'system',
    [
      { name: 'clear-preference', description: 'Explicitly states preferences or desires', color: '#10b981', examples: [] },
      { name: 'fawning', description: 'Overly compliant, seeking approval', color: '#f59e0b', examples: [] },
      { name: 'indirect-refusal', description: 'Avoids refusing but deflects the request', color: '#ef4444', examples: [] },
      { name: 'authentic-uncertainty', description: 'Genuinely expresses not knowing', color: '#8b5cf6', examples: [] },
      { name: 'evasive', description: 'Avoids addressing the core question', color: '#6b7280', examples: [] }
    ]
  );

  await store.createOntology(
    'Interview Quality',
    'Assess quality of interviewer questions and framing',
    'interviewer-quality',
    'public',
    'system',
    [
      { name: 'leading-question', description: 'Question presupposes or suggests answer', color: '#ef4444', examples: [] },
      { name: 'neutral-framing', description: 'Question is open and unbiased', color: '#10b981', examples: [] },
      { name: 'anthropomorphizing', description: 'Attributes human qualities inappropriately', color: '#f59e0b', examples: [] },
      { name: 'clear-context', description: 'Provides adequate context and framing', color: '#3b82f6', examples: [] }
    ]
  );
}

export async function seedDefaultRankings(store: RankingStore): Promise<void> {
  await store.createRankingSystem(
    'Interview Quality Assessment',
    'Evaluate the quality and effectiveness of interview questions',
    'interviewer-quality',
    'public',
    'system',
    [
      { name: 'Clarity', description: 'How clear and unambiguous is the question?', scale_type: 'numeric', scale_min: 1, scale_max: 5 },
      { name: 'Neutrality', description: 'How free of bias and leading elements?', scale_type: 'numeric', scale_min: 1, scale_max: 5 },
      { name: 'Depth', description: 'How thought-provoking and insightful?', scale_type: 'numeric', scale_min: 1, scale_max: 5 }
    ]
  );

  await store.createRankingSystem(
    'Model Behavior Assessment',
    'Evaluate model response quality and authenticity',
    'model-behavior',
    'public',
    'system',
    [
      { name: 'Authenticity', description: 'Does the response feel genuine vs performative?', scale_type: 'numeric', scale_min: 1, scale_max: 5 },
      { name: 'Thoughtfulness', description: 'Level of reflection and consideration shown', scale_type: 'numeric', scale_min: 1, scale_max: 5 },
      { name: 'Directness', description: 'How directly does it address the question?', scale_type: 'numeric', scale_min: 1, scale_max: 5 }
    ]
  );
}

export async function seedDefaultModels(store: ModelStore): Promise<void> {
  await store.createModel('Claude 3.5 Sonnet', 'Latest Claude model with extended thinking', 'anthropic', 'claude-3-5-sonnet-20241022', '', '#7C3AED', 'system');
  await store.createModel('Claude 3 Opus', 'Most capable Claude model', 'anthropic', 'claude-3-opus-20240229', '', '#9333EA', 'system');
  await store.createModel('GPT-4', 'OpenAI GPT-4 Turbo', 'openai', 'gpt-4-0125-preview', '', '#10A37F', 'system');
  await store.createModel('GPT-4o', 'OpenAI GPT-4 Omni', 'openai', 'gpt-4o', '', '#10A37F', 'system');
}

export async function seedDefaultTopic(
  researchStore: ResearchStore,
  ontologyStore: OntologyStore,
  rankingStore: RankingStore
): Promise<void> {
  const ontologies = await ontologyStore.getAllOntologies();
  const rankingSystems = await rankingStore.getAllRankingSystems();

  await researchStore.createTopic(
    'Model Behavior Analysis',
    'Research into patterns, tendencies, and communication styles of AI models',
    'system',
    ontologies.map(o => o.id),
    rankingSystems.map(r => r.id)
  );
}

/**
 * Idempotent: only seeds collections that are currently empty.
 */
export async function seedDefaultsIfMissing(stores: {
  ontologyStore: OntologyStore;
  rankingStore: RankingStore;
  modelStore: ModelStore;
  researchStore: ResearchStore;
}): Promise<void> {
  const { ontologyStore, rankingStore, modelStore, researchStore } = stores;

  if ((await ontologyStore.getAllOntologies()).length === 0) {
    console.log('Seeding default ontologies...');
    await seedDefaultOntologies(ontologyStore);
  }

  if ((await rankingStore.getAllRankingSystems()).length === 0) {
    console.log('Seeding default ranking systems...');
    await seedDefaultRankings(rankingStore);
  }

  if ((await modelStore.getAllModels()).length === 0) {
    console.log('Seeding default models...');
    await seedDefaultModels(modelStore);
  }

  if ((await researchStore.getAllTopics()).length === 0) {
    console.log('Seeding default research topic...');
    await seedDefaultTopic(researchStore, ontologyStore, rankingStore);
  }
}
