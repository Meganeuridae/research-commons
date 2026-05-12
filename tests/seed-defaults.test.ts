import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { OntologyStore } from '../src/services/ontology-store.js';
import { RankingStore } from '../src/services/ranking-store.js';
import { ModelStore } from '../src/services/model-store.js';
import { ResearchStore } from '../src/services/research-store.js';
import { seedDefaultsIfMissing } from '../src/seeds/defaults.js';

let tmpDir: string;

async function makeStores() {
  const ontologyStore = new OntologyStore(tmpDir);
  const rankingStore = new RankingStore(tmpDir);
  const modelStore = new ModelStore(tmpDir);
  const researchStore = new ResearchStore(tmpDir);
  await Promise.all([
    ontologyStore.init(),
    rankingStore.init(),
    modelStore.init(),
    researchStore.init(),
  ]);
  return { ontologyStore, rankingStore, modelStore, researchStore };
}

async function closeAll(stores: Awaited<ReturnType<typeof makeStores>>) {
  await stores.ontologyStore.close();
  await stores.rankingStore.close();
  await stores.modelStore.close();
  await stores.researchStore.close();
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-defaults-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('seedDefaultsIfMissing', () => {
  it('creates default ontologies, rankings, models, and a topic', async () => {
    const stores = await makeStores();
    await seedDefaultsIfMissing(stores);

    expect((await stores.ontologyStore.getAllOntologies()).length).toBeGreaterThan(0);
    expect((await stores.rankingStore.getAllRankingSystems()).length).toBeGreaterThan(0);
    expect((await stores.modelStore.getAllModels()).length).toBeGreaterThan(0);
    expect((await stores.researchStore.getAllTopics()).length).toBeGreaterThan(0);

    await closeAll(stores);
  });

  it('is idempotent: re-running does not duplicate existing data', async () => {
    const stores = await makeStores();
    await seedDefaultsIfMissing(stores);

    const ontCount = (await stores.ontologyStore.getAllOntologies()).length;
    const rankCount = (await stores.rankingStore.getAllRankingSystems()).length;
    const modelCount = (await stores.modelStore.getAllModels()).length;
    const topicCount = (await stores.researchStore.getAllTopics()).length;

    await seedDefaultsIfMissing(stores);

    expect((await stores.ontologyStore.getAllOntologies())).toHaveLength(ontCount);
    expect((await stores.rankingStore.getAllRankingSystems())).toHaveLength(rankCount);
    expect((await stores.modelStore.getAllModels())).toHaveLength(modelCount);
    expect((await stores.researchStore.getAllTopics())).toHaveLength(topicCount);

    await closeAll(stores);
  });
});
