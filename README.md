<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# PersonalityDec2

A browser telemetry and behavioral analytics app that combines YouTube/browser event capture, Gemini AI enrichment, and Big Five personality estimation.

This project includes:
- A React + Vite frontend for login, consent, questionnaire, extension connection, and dashboard visualization.
- An Express backend API that handles authentication, telemetry ingestion, AI enrichment, MongoDB/Firebase fallback storage, and dashboard telemetry.
- A Chrome extension scaffold under `extension/` for collecting browser events and connecting to the app.
- Optional Python ML utilities in `ml/` for dataset creation, training, evaluation, and predictions.

## Features

- User authentication with JWT
- Consent collection and withdrawal
- YouTube and browser event ingestion
- Live dashboard telemetry with charts and AI-enriched data
- Gemini AI integration for content classification
- Big Five personality score calculation
- Local fallback storage for reliability when external DBs are unavailable

## Run Locally

**Prerequisites:**
- Node.js 20+ (recommended)
- npm

1. Install Node dependencies:
   `npm install`
2. Copy the example env file:
   `copy .env.example .env`
3. Update `.env` with your values:
   - `GEMINI_API_KEY`
   - `MONGODB_URI`
   - `JWT_SECRET`
   - `APP_URL` if needed for your deployment / extension callbacks
4. Start the app:
   `npm run dev`

The app will run on `http://localhost:3000` by default.

## Build and Run Production

1. Build the app:
   `npm run build`
2. Start the built server:
   `npm start`

## Optional Python ML utilities

If you want to run the ML scripts, install Python dependencies:
`pip install -r requirements.txt`

The `ml/` folder contains utilities for dataset generation, model training, evaluation, and prediction.

## Project structure

- `src/` — React frontend pages and components
- `server.ts` — Express backend server entrypoint
- `server/` — backend helper modules (`mongodb.ts`, `enrichment_service.ts`, `bfi44.ts`, etc.)
- `extension/` — Chrome extension files
- `ml/` — Python machine learning scripts

## Notes

- The app already supports MongoDB and Firestore fallback storage.
- If you run into CORS issues with the extension, make sure the extension origin is allowed by the backend.
