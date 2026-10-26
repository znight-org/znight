import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    memory: 'src/drivers/memory.ts',
    rabbitmq: 'src/drivers/rabbitmq.ts',
    sqs: 'src/drivers/sqs.ts',
    kafka: 'src/drivers/kafka.ts',
    compiler: 'src/compiler/index.ts',
  },
  format: 'esm',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['amqplib', '@aws-sdk/client-sqs', '@platformatic/kafka'],
})
