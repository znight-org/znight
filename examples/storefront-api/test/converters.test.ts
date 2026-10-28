import { buildOpenApiDocument } from '@znight/openapi'
import * as v from 'valibot'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { AddCartItem } from '../src/carts/cart.schemas.js'
import { CreateProduct } from '../src/catalog/product.schemas.js'
import converters, { valibotDiscriminators } from '../src/openapi.converters.js'
import { PlaceOrder } from '../src/orders/order.schemas.js'
import { describe, expect, test as it } from 'bun:test'

const input = { io: 'input', target: 'draft-2020-12', lenient: false } as const

describe('valibotDiscriminators', () => {
  it('documents v.variant() as oneOf + discriminator, each named option a definition', async () => {
    const schema = await valibotDiscriminators.convert(PlaceOrder, input)

    expect(schema?.properties).toMatchObject({
      payment: {
        oneOf: [{ $ref: '#/$defs/CardPaymentInput' }, { $ref: '#/$defs/TransferPaymentInput' }],
        discriminator: {
          propertyName: 'method',
          mapping: {
            card: '#/components/schemas/CardPaymentInput',
            transfer: '#/components/schemas/TransferPaymentInput',
          },
        },
      },
    })
    expect(schema?.$defs).toMatchObject({
      CardPaymentInput: { type: 'object', required: ['method', 'token'], title: 'CardPaymentInput' },
      TransferPaymentInput: { type: 'object', required: ['method'], title: 'TransferPaymentInput' },
    })
  })

  it('leaves the other Valibot schemas as @valibot/to-json-schema writes them', async () => {
    expect(await valibotDiscriminators.convert(AddCartItem, input)).toMatchObject({
      type: 'object',
      required: ['productId'],
    })
    // options without a title stay inline: there is no name for a component
    const anonymous = v.variant('kind', [v.object({ kind: v.literal('a') }), v.object({ kind: v.literal('b') })])
    const schema = await valibotDiscriminators.convert(anonymous, input)
    expect(schema?.oneOf).toHaveLength(2)
    expect(schema?.discriminator).toBeUndefined()
    expect(schema?.$defs).toBeUndefined()
  })

  it('lets the built-in converters handle the other libraries', async () => {
    // a Zod schema: `undefined`, the next converter (Standard JSON Schema) is tried
    expect(await valibotDiscriminators.convert(CreateProduct, input)).toBeUndefined()
  })

  it('must reach every assembly of the document', async () => {
    // without the converters, the request body of POST /orders has an inline oneOf: the committed
    // openapi.json would differ from the served document
    const without = await buildOpenApiDocument(metadata)
    const withConverters = await buildOpenApiDocument(metadata, { converters })

    expect(without.document.components?.schemas?.CardPaymentInput).toBeUndefined()
    expect(withConverters.document.components?.schemas?.CardPaymentInput).toBeDefined()
    expect(without.json).not.toBe(withConverters.json)
  })
})
