import { DataSource } from 'typeorm';
import { AiKnowledgeEntry } from './src/ai-knowledge-hub/entities/ai-knowledge-entry.entity';
import { AiKnowledgeEntryRevision } from './src/ai-knowledge-hub/entities/ai-knowledge-entry-revision.entity';
import { AiKnowledgeAuditLog } from './src/ai-knowledge-hub/entities/ai-knowledge-audit-log.entity';

(async () => {
  const ds = new DataSource({
    type: 'postgres',
    host: 'localhost',
    port: 5432,
    username: 'postgres',
    password: 'Pao@1234!',
    database: 'project_bank',
    entities: [AiKnowledgeEntry, AiKnowledgeEntryRevision, AiKnowledgeAuditLog],
    synchronize: false,
  });
  await ds.initialize();
  const sqlInMemory = await ds.driver.createSchemaBuilder().log();
  console.log('pending up-queries:', sqlInMemory.upQueries.length);
  sqlInMemory.upQueries.forEach((q) => console.log('  -', q.query));
  await ds.destroy();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
