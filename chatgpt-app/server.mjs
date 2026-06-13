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

const WIDGET_URI = 'ui://widget/grace-design-concept-v2.html'
const MCP_PATH = '/mcp'
const APP_ORIGIN = 'https://grace-chatgpt-app.onrender.com'
const port = Number(process.env.PORT ?? 8787)
const host = process.env.HOST ?? '0.0.0.0'
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
  concept: conceptSchema.omit({
    artworkImage: true,
    mockupImage: true,
  }),
}

function clean(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function conceptResponse(concept, message) {
  const { artworkImage, mockupImage, ...modelConcept } = concept
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { concept: modelConcept },
    _meta: {
      concept,
    },
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
  const server = new McpServer(
    {
      name: 'grace-design-studio',
      version: '0.2.0',
    },
    {
      instructions:
        'GRACE creates apparel concepts, artwork, and garment mockups. If the user asks for a complete design or a visual, create the concept, then generate artwork, then generate a garment mockup. If the user asks only for a concept or says not to generate images, stop after the concept.',
    },
  )

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
              domain: APP_ORIGIN,
              csp: {
                connectDomains: [],
                resourceDomains: [],
              },
            },
            'openai/widgetDescription':
              'An interactive apparel design card that shows the concept, generated artwork, and garment mockup.',
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
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
      },
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
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
      },
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
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
      },
      _meta: {
        ui: { resourceUri: WIDGET_URI },
        'openai/toolInvocation/invoking': 'Creating artwork...',
        'openai/toolInvocation/invoked': 'Artwork created.',
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
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
      },
      _meta: {
        ui: { resourceUri: WIDGET_URI },
        'openai/toolInvocation/invoking': 'Creating garment mockup...',
        'openai/toolInvocation/invoked': 'Garment mockup created.',
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
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
      },
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

  if (req.method === 'GET' && url.pathname === '/privacy') {
    res
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(policyPage('Privacy Policy', `
        <p>GRACE Design Studio processes the apparel design details you provide so it can create concepts, artwork, mockups, and production summaries.</p>
        <h2>Data we process</h2>
        <p>Design prompts may include brand names, garment details, creative direction, and production notes. Please do not submit passwords, payment information, government identifiers, health information, or other sensitive personal data.</p>
        <h2>How data is used and shared</h2>
        <p>Design details are processed by the GRACE app server and OpenAI services solely to provide the requested result. We do not sell personal data or use it for advertising.</p>
        <h2>Retention and controls</h2>
        <p>Current design state is stored only in temporary server memory and may be erased whenever the service restarts or sleeps. You can stop using or disconnect the app at any time from ChatGPT settings.</p>
      `))
    return
  }

  if (req.method === 'GET' && url.pathname === '/terms') {
    res
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(policyPage('Terms of Use', `
        <p>GRACE Design Studio provides creative apparel concepts and production-planning assistance. Generated results may contain errors and should be reviewed before manufacturing, publishing, or commercial use.</p>
        <p>You are responsible for ensuring that names, logos, artwork, and other materials you provide or use do not violate third-party rights. Do not use the app for unlawful, deceptive, or harmful content.</p>
        <p>The service is provided as available and may change as the product develops.</p>
      `))
    return
  }

  if (req.method === 'GET' && url.pathname === '/support') {
    res
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(policyPage('Support', `
        <p>For help with GRACE Design Studio, report an issue through the public project support page.</p>
        <p><a href="https://github.com/kdcamp11/grace-chatgpt-app/issues">Open the GRACE support page</a></p>
      `))
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

function policyPage(title, body) {
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>${title} | GRACE Design Studio</title>
      <style>
        body { max-width: 760px; margin: 0 auto; padding: 48px 24px; color: #10251e; background: #fbfdfb; font: 16px/1.65 Inter, system-ui, sans-serif; }
        h1, h2 { color: #184d3e; line-height: 1.2; }
        h1 { margin-bottom: 28px; }
        h2 { margin-top: 30px; font-size: 20px; }
        a { color: #184d3e; font-weight: 700; }
        footer { margin-top: 44px; padding-top: 20px; border-top: 1px solid #d9e5df; color: #60736b; font-size: 14px; }
      </style>
    </head>
    <body>
      <h1>${title}</h1>
      ${body}
      <footer>GRACE Design Studio · Effective June 12, 2026</footer>
    </body>
  </html>`
}
