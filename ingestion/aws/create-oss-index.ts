/**
 * Create the vector index inside an OpenSearch Serverless (AOSS) collection.
 *
 * Bedrock Knowledge Base requires:
 *   - knn_vector field (1024 dims for Titan Embeddings v2)
 *   - text field (the source chunk)
 *   - metadata field (the JSON sidecar contents)
 *
 * This is the one piece that `aws` CLI cannot do — AOSS index management
 * goes through the OpenSearch HTTP API (signed with SigV4 for service=aoss).
 *
 * Usage:
 *   AWS_REGION=us-west-2 \
 *   OSS_ENDPOINT=https://xxxxxxxxxxxx.us-west-2.aoss.amazonaws.com \
 *   INDEX_NAME=teams-chats-vector \
 *   npm run aws:create-index
 */

import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

const REGION = process.env.AWS_REGION ?? 'us-west-2';
const ENDPOINT = process.env.OSS_ENDPOINT;
const INDEX = process.env.INDEX_NAME ?? 'teams-chats-vector';

if (!ENDPOINT) {
  console.error('❌ OSS_ENDPOINT env var is required');
  console.error('   Get it from: aws opensearchserverless batch-get-collection ...');
  process.exit(1);
}

const client = new Client({
  ...AwsSigv4Signer({
    region: REGION,
    service: 'aoss',
    getCredentials: () => defaultProvider()(),
  }),
  node: ENDPOINT,
});

const indexBody = {
  settings: {
    index: {
      knn: true,
    },
  },
  mappings: {
    properties: {
      'bedrock-knowledge-base-default-vector': {
        type: 'knn_vector',
        dimension: 1024,
        method: {
          name: 'hnsw',
          engine: 'faiss',
          space_type: 'l2',
          parameters: {
            ef_construction: 512,
            m: 16,
          },
        },
      },
      'AMAZON_BEDROCK_TEXT_CHUNK': {
        type: 'text',
        index: true,
      },
      'AMAZON_BEDROCK_METADATA': {
        type: 'text',
        index: false,
      },
    },
  },
};

async function main(): Promise<void> {
  console.log(`Connecting to ${ENDPOINT}`);
  console.log(`Creating index "${INDEX}"...`);

  try {
    const exists = await client.indices.exists({ index: INDEX });
    if (exists.body) {
      console.log(`ℹ️  Index "${INDEX}" already exists. Skipping create.`);
      return;
    }
  } catch (err) {
    // Some auth/setup errors throw here. Surface them clearly.
    const msg = (err as Error).message ?? String(err);
    console.error(`Failed to check index existence: ${msg}`);
    throw err;
  }

  const response = await client.indices.create({ index: INDEX, body: indexBody });
  console.log(`✅ Index created: ${JSON.stringify(response.body)}`);

  // AOSS index becomes queryable after a short propagation delay (~30s).
  console.log('   (Wait ~30 seconds before creating the Knowledge Base.)');
}

main().catch((err) => {
  console.error('❌ Fatal:', (err as Error).message ?? err);
  process.exit(1);
});
