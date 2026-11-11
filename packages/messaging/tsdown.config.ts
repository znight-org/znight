import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    memory: 'src/drivers/memory.ts',
    rabbitmq: 'src/drivers/rabbitmq.ts',
    sqs: 'src/drivers/sqs.ts',
    kafka: 'src/drivers/kafka.ts',
    pubsub: 'src/drivers/pubsub.ts',
    nats: 'src/drivers/nats.ts',
    'azure-service-bus': 'src/drivers/azure-service-bus.ts',
    testing: 'src/testing.ts',
    compiler: 'src/compiler/index.ts',
  },
  format: 'esm',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
  external: [
    'amqplib',
    '@aws-sdk/client-sqs',
    '@platformatic/kafka',
    '@google-cloud/pubsub',
    '@nats-io/jetstream',
    '@nats-io/transport-node',
    '@azure/service-bus',
    '@azure/identity',
  ],
})
