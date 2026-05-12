#!/usr/bin/env tsx
import 'dotenv/config';
import { OntologyStore } from '../src/services/ontology-store.js';
import { RankingStore } from '../src/services/ranking-store.js';
import { ModelStore } from '../src/services/model-store.js';
import { ResearchStore } from '../src/services/research-store.js';
import { seedDefaultsIfMissing } from '../src/seeds/defaults.js';

const DATA_PATH = process.env.DATA_PATH || './data';

async function main() {
  const ontologyStore = new OntologyStore(DATA_PATH);
  const rankingStore = new RankingStore(DATA_PATH);
  const modelStore = new ModelStore(DATA_PATH);
  const researchStore = new ResearchStore(DATA_PATH);

  await ontologyStore.init();
  await rankingStore.init();
  await modelStore.init();
  await researchStore.init();

  await seedDefaultsIfMissing({ ontologyStore, rankingStore, modelStore, researchStore });

  await ontologyStore.close();
  await rankingStore.close();
  await modelStore.close();
  await researchStore.close();

  console.log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
