import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

const WIDGET_URI = 'ui://widget/grace-design-concept.html'
const MCP_PATH = '/mcp'
const port = Number(process.env.PORT ?? 8787)
const host = process.env.HOST ?? '127.0.0.1'
const widgetHtml = readFileSync(
  fileURLToPath(new URL('./widget.html', import.meta.url)),
  'utf8',
)

const concepts = new Map()

const conceptSchema = z.object({
  id: z.string(),
  brandName: z.string(),
  garmentType: z.string(),
  garmentColor: z.string(),
  designDirection: z.string(),
  placement: z.string(),
  decorationMethod: z.string(),
  audience: z.string(),
  notes: z.string(),
  status: z.enum(['concept', 'ready-for-artwork']),
  artworkImage: z.string().optional(),
  mockupImage: z.string().optional(),
})

const outputSchema = {
  concept: conceptSchema,
}

function clean(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function conceptResponse(concept, message) {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { concept },
  }
}

function missingApiKey() {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: 'Image generation needs an OPENAI_API_KEY on the GRACE app server.',
      },
    ],
  }
}

async function generateImage(prompt, referenceImage) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return null

  let response
  if (referenceImage) {
    const match = referenceImage.match(/^data:([^;]+);base64,(.+)$/)
    if (!match) throw new Error('The saved artwork image is not a valid data URL.')

    const form = new FormData()
    form.append('model', 'gpt-image-2')
    form.append('prompt', prompt)
    form.append('image[]', new Blob([Buffer.from(match[2], 'base64')], { type: match[1] }), 'artwork.png')
    form.append('size', '1024x1024')
    form.append('quality', 'medium')

    response = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    })
  } else {
    response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-image-2',
        prompt,
        size: '1024x1024',
        quality: 'medium',
      }),
    })
  }

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`OpenAI image generation failed (${response.status}): ${detail}`)
  }

  const data = await response.json()
  const image = data?.data?.[0]?.b64_json
  if (!image) throw new Error('OpenAI returned no image.')
  return `data:image/png;base64,${image}`
}

function createGraceServer() {
  const server = new McpServer({
    name: 'grace-design-studio',
    version: '0.1.0',
  })

  registerAppResource(
    server,
    'grace-design-concept',
    WIDGET_URI,
    {},
    async () => ({
      contents: [
        {
          uri: WIDGET_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: widgetHtml,
          _meta: {
            ui: {
              prefersBorder: false,
            },
          },
        },
      ],
    }),
  )

  registerAppTool(
    server,
    'create_design_concept',
    {
      title: 'Create apparel design concept',
      description:
        'Create a structured apparel design concept when the user wants to design clothing, merchandise, or a branded garment.',
      inputSchema: {
        brandName: z.string().min(1).describe('Brand, team, event, or collection name'),
        garmentType: z.string().min(1).describe('Garment such as hoodie, tee, jacket, or sweatpants'),
        garmentColor: z.string().optional().describe('Primary garment color'),
        designDirection: z.string().optional().describe('Visual style or creative direction'),
        placement: z.string().optional().describe('Primary graphic placement'),
        decorationMethod: z.string().optional().describe('Print, embroidery, applique, or other method'),
        audience: z.string().optional().describe('Intended customer or wearer'),
        notes: z.string().optional().describe('Any extra creative or production requirements'),
      },
      outputSchema,
      _meta: {
        ui: { resourceUri: WIDGET_URI },
      },
    },
    async (args) => {
      const id = crypto.randomUUID()
      const concept = {
        id,
        brandName: clean(args?.brandName, 'Untitled Brand'),
        garmentType: clean(args?.garmentType, 'T-shirt'),
        garmentColor: clean(args?.garmentColor, 'Black'),
        designDirection: clean(args?.designDirection, 'Clean, elevated streetwear'),
        placement: clean(args?.placement, 'Center chest'),
        decorationMethod: clean(args?.decorationMethod, 'Screen print'),
        audience: clean(args?.audience, 'Unisex'),
        notes: clean(args?.notes, 'No additional requirements yet.'),
        status: 'concept',
      }

      concepts.set(id, concept)
      return conceptResponse(
        concept,
        `Created a ${concept.garmentColor} ${concept.garmentType} concept for ${concept.brandName}.`,
      )
    },
  )

  registerAppTool(
    server,
    'revise_design_concept',
    {
      title: 'Revise apparel design concept',
      description:
        'Update an existing GRACE apparel concept after the user requests a change to color, garment, style, placement, decoration, audience, notes, or readiness.',
      inputSchema: {
        id: z.string().min(1).describe('Concept id returned by create_design_concept'),
        brandName: z.string().optional(),
        garmentType: z.string().optional(),
        garmentColor: z.string().optional(),
        designDirection: z.string().optional(),
        placement: z.string().optional(),
        decorationMethod: z.string().optional(),
        audience: z.string().optional(),
        notes: z.string().optional(),
        readyForArtwork: z.boolean().optional().describe('Mark the concept ready for artwork'),
      },
      outputSchema,
      _meta: {
        ui: { resourceUri: WIDGET_URI },
      },
    },
    async (args) => {
      const current = concepts.get(args?.id)
      if (!current) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'That design concept was not found. Create a new concept first.',
            },
          ],
        }
      }

      const fields = [
        'brandName',
        'garmentType',
        'garmentColor',
        'designDirection',
        'placement',
        'decorationMethod',
        'audience',
        'notes',
      ]
      const updates = {}
      for (const field of fields) {
        if (typeof args[field] === 'string' && args[field].trim()) {
          updates[field] = args[field].trim()
        }
      }

      const concept = {
        ...current,
        ...updates,
        status:
          typeof args.readyForArtwork === 'boolean'
            ? args.readyForArtwork
              ? 'ready-for-artwork'
              : 'concept'
            : current.status,
      }
      concepts.set(concept.id, concept)

      return conceptResponse(concept, `Updated the ${concept.brandName} design concept.`)
    },
  )

  registerAppTool(
    server,
    'generate_logo_artwork',
    {
      title: 'Generate logo artwork',
      description:
        'Generate polished logo or graphic artwork for an existing GRACE apparel concept. Use after creating the concept and before creating a garment mockup.',
      inputSchema: {
        id: z.string().min(1).describe('Concept id returned by create_design_concept'),
        artworkDirection: z
          .string()
          .optional()
          .describe('Specific wording, symbols, typography, or art direction'),
      },
      outputSchema,
      _meta: {
        ui: { resourceUri: WIDGET_URI },
      },
    },
    async (args) => {
      const concept = concepts.get(args?.id)
      if (!concept) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'That design concept was not found.' }],
        }
      }
      if (!process.env.OPENAI_API_KEY) return missingApiKey()

      const direction = clean(args?.artworkDirection, concept.designDirection)
      const prompt = [
        `Create standalone apparel artwork for the brand "${concept.brandName}".`,
        `Creative direction: ${direction}.`,
        `The artwork will be applied to a ${concept.garmentColor} ${concept.garmentType} using ${concept.decorationMethod}.`,
        `Intended placement: ${concept.placement}.`,
        'Professional fashion-brand graphic, centered composition, crisp edges, production-ready visual.',
        'Isolated artwork only, transparent or plain neutral background, no garment, no model, no mockup, no watermark.',
      ].join(' ')

      try {
        const artworkImage = await generateImage(prompt)
        const updated = { ...concept, artworkImage, status: 'ready-for-artwork' }
        concepts.set(updated.id, updated)
        return conceptResponse(updated, `Generated artwork for the ${concept.brandName} concept.`)
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: error instanceof Error ? error.message : 'Artwork generation failed.',
            },
          ],
        }
      }
    },
  )

  registerAppTool(
    server,
    'generate_garment_mockup',
    {
      title: 'Generate garment mockup',
      description:
        'Generate a photorealistic product mockup for an existing GRACE apparel concept, using its generated artwork when available.',
      inputSchema: {
        id: z.string().min(1).describe('Concept id returned by create_design_concept'),
        view: z.enum(['front', 'back', 'detail']).optional().describe('Requested product view'),
        mockupNotes: z.string().optional().describe('Extra styling or photography instructions'),
      },
      outputSchema,
      _meta: {
        ui: { resourceUri: WIDGET_URI },
      },
    },
    async (args) => {
      const concept = concepts.get(args?.id)
      if (!concept) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'That design concept was not found.' }],
        }
      }
      if (!process.env.OPENAI_API_KEY) return missingApiKey()

      const view = clean(args?.view, 'front')
      const prompt = [
        `Create premium ecommerce product photography of a ${concept.garmentColor} ${concept.garmentType}, ${view} view.`,
        `Apply the supplied brand artwork at the ${concept.placement} using a realistic ${concept.decorationMethod} treatment.`,
        `The visual direction is ${concept.designDirection}.`,
        `Audience and fit: ${concept.audience}.`,
        clean(args?.mockupNotes, concept.notes),
        'Show the full garment on a clean warm-white studio background.',
        'No person, no mannequin, no extra text, no watermark. Preserve the supplied artwork faithfully.',
      ].join(' ')

      try {
        const mockupImage = await generateImage(prompt, concept.artworkImage)
        const updated = { ...concept, mockupImage }
        concepts.set(updated.id, updated)
        return conceptResponse(updated, `Generated the ${view} mockup for ${concept.brandName}.`)
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: error instanceof Error ? error.message : 'Mockup generation failed.',
            },
          ],
        }
      }
    },
  )

  registerAppTool(
    server,
    'build_tech_pack_summary',
    {
      title: 'Build tech pack summary',
      description:
        'Create a concise production handoff summary for an existing GRACE apparel concept.',
      inputSchema: {
        id: z.string().min(1).describe('Concept id returned by create_design_concept'),
        sizeRange: z.string().optional().describe('Requested size range'),
        fabric: z.string().optional().describe('Fabric composition or weight'),
        quantity: z.string().optional().describe('Estimated order quantity'),
      },
      outputSchema,
      _meta: {
        ui: { resourceUri: WIDGET_URI },
      },
    },
    async (args) => {
      const concept = concepts.get(args?.id)
      if (!concept) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'That design concept was not found.' }],
        }
      }

      const productionNotes = [
        concept.notes,
        `Size range: ${clean(args?.sizeRange, 'XS-3XL')}.`,
        `Fabric: ${clean(args?.fabric, 'Confirm fabric weight and composition with supplier')}.`,
        `Quantity: ${clean(args?.quantity, 'To be confirmed')}.`,
        `Decoration: ${concept.decorationMethod} at ${concept.placement}.`,
      ].join(' ')
      const updated = { ...concept, notes: productionNotes, status: 'ready-for-artwork' }
      concepts.set(updated.id, updated)
      return conceptResponse(updated, `Prepared a production summary for ${concept.brandName}.`)
    },
  )

  return server
}

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end('Missing URL')
    return
  }

  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)

  if (req.method === 'OPTIONS' && url.pathname === MCP_PATH) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, mcp-session-id',
      'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    })
    res.end()
    return
  }

  if (req.method === 'GET' && url.pathname === '/') {
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(
        JSON.stringify({
          name: 'GRACE Design Studio',
          mcp: MCP_PATH,
          imageGeneration: Boolean(process.env.OPENAI_API_KEY),
        }),
      )
    return
  }

  const mcpMethods = new Set(['POST', 'GET', 'DELETE'])
  if (url.pathname === MCP_PATH && req.method && mcpMethods.has(req.method)) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id')

    const server = createGraceServer()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })

    res.on('close', () => {
      transport.close()
      server.close()
    })

    try {
      await server.connect(transport)
      await transport.handleRequest(req, res)
    } catch (error) {
      console.error('Error handling MCP request:', error)
      if (!res.headersSent) {
        res.writeHead(500).end('Internal server error')
      }
    }
    return
  }

  res.writeHead(404).end('Not Found')
})

httpServer.listen(port, host, () => {
  console.log(`GRACE ChatGPT app listening on http://${host}:${port}${MCP_PATH}`)
})
