# GRACE Design Studio for ChatGPT

GRACE Design Studio is an OpenAI Apps SDK application for creating apparel
concepts, artwork, garment mockups, and production tech pack summaries inside
ChatGPT.

## Tools

- `create_design_concept`
- `revise_design_concept`
- `generate_logo_artwork`
- `generate_garment_mockup`
- `build_tech_pack_summary`

## Run locally

1. Install Node.js 22 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env.local`.
4. Add an OpenAI API key to `.env.local` for image generation.
5. Run `npm run dev`.

The MCP endpoint is `http://127.0.0.1:8787/mcp`.

## Deploy

The included `render.yaml` can deploy the app as a Render web service. Set
`OPENAI_API_KEY` as a secret environment variable in Render. After deployment,
connect `https://YOUR-SERVICE.onrender.com/mcp` as a custom app in ChatGPT
developer mode.

Never commit `.env.local` or an API key.
