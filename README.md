# 🧠 Ethos — Behavioral Telemetry & Personality Intelligence

> **What does your digital footprint say about you?**  
> Ethos transforms passive YouTube watch history into deep, actionable personality insights using Gemini AI content analysis and Big Five (OCEAN) machine learning models.

---

## ✨ Overview

Ethos explores a simple yet profound question: *Can your everyday media consumption reveal who you are?*

By analyzing video watch patterns, content topics, time-of-day habits, and topic diversity, Ethos generates a real-time behavioral profile mapped to the **Big Five Personality Model (OCEAN)**:
- 🎨 **Openness to Experience** — Curiosity, topic diversity & intellectual exploration
- 🎯 **Conscientiousness** — Routine regularity, activity consistency & educational focus
- ⚡ **Extraversion** — High-energy, social & dynamic content preference
- 🤝 **Agreeableness** — Positive tone & collaborative sentiment preference
- 🌊 **Neuroticism** — Mood variance & late-night watch habits

---

## 🔒 Privacy & Explicit User Consent

Ethos is built on a **Privacy-by-Design** foundation. Your behavioral telemetry belongs strictly to you.

- 🛡️ **Explicit Opt-In Gateway**: Telemetry collection remains 100% inactive until you review and grant explicit consent via the interactive Consent screen.
- 🎛️ **Total User Control**: Withdraw consent or permanently delete all your stored watch history, behavioral features, and personality predictions at any time with a single click.
- 🔐 **Secure & Transparent**: Built with JWT authentication, strict CORS origins, and automatic multi-tier fallback storage (including local FileStore JSON) so your data stays resilient and protected.

---

## 🛠️ Tech Stack

Ethos combines modern web technologies, dual-engine backend servers, and machine learning into an agile, highly resilient ecosystem:

| Layer | Technologies |
| :--- | :--- |
| **Frontend** | React 19, Vite, TypeScript, Tailwind CSS, Recharts, Lucide Icons |
| **Backend (Node)** | Express.js, TypeScript, `tsx`, JWT Authentication, Cookie Parser |
| **Backend (Python)** | FastAPI, Pydantic, Motor (Async MongoDB Driver), Uvicorn |
| **AI & Semantic Engine** | Google Gemini API (`@google/genai`) for video topic & user intent classification |
| **Machine Learning** | Python, Scikit-learn (MultiOutput ElasticNet), NumPy, Pandas |
| **Database Architecture** | Multi-tier setup: MongoDB Atlas (Primary) ➔ Firebase Firestore (Fallback) ➔ Local FileStore JSON (Guaranteed Uptime) |
| **Telemetry Capture** | Chrome Extension (Manifest V3) for passive, non-intrusive event capture |

---

## 🤖 Machine Learning Engine

The Ethos personality engine bridges daily digital habits with psychological ground truth derived from the **BFI-44 (Big Five Inventory)** questionnaire:

1. **Behavioral Feature Engineering**: Distills raw video watch events into 5 core psychological signals:
   - `avg_session_duration` — Attention span and engagement depth
   - `late_night_ratio` — Circadian discipline & night-owl habits (watching between 10 PM – 4 AM)
   - `topic_diversity` — Semantic curiosity breadth calculated via Gemini AI tag analysis
   - `learning_ratio` — Educational vs. entertainment content balance
   - `activity_consistency` — Behavioral routine regularity
2. **Model Architecture**: MultiOutput ElasticNet Regressor ($L_1 + L_2$ regularization) mapping 5D behavioral feature vectors to 5-factor OCEAN scores.
3. **Validation Rigor**: Evaluated using strict **Leave-One-Out Cross Validation (LOOCV)** to guarantee zero data leakage across user profiles.

---

## 🚀 Quickstart & Setup

### Prerequisites
- **Node.js 20+** & **npm**
- **Python 3.10+** (for ML model training or running the FastAPI backend)

### 1. Installation
```bash
git clone https://github.com/alinpaul3/Ethos.git
cd Ethos
npm install
```

### 2. Environment Configuration
Copy `.env.example` to `.env` and fill in your keys:
```bash
copy .env.example .env
```
Key configuration items:
- `GEMINI_API_KEY`: Your Google Gemini API key
- `MONGODB_URI`: (Optional) MongoDB connection string
- `JWT_SECRET`: Secret key for signing JWT tokens

### 3. Run Locally
```bash
# Starts the combined Express backend + Vite dev server (http://localhost:3000)
npm run dev
```

### 4. Load the Chrome Extension
1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `extension/` directory from this repository.
4. Register or log into Ethos on `http://localhost:3000`, grant consent, connect your Extension ID, and start watching YouTube!

---

## 💡 Scientific Credit & Inspiration

Ethos is inspired by the pioneering psychometric research of **Dr. Michal Kosinski** (alongside David Stillwell & Thore Graepel), whose landmark Cambridge and Stanford studies proved that digital footprints—such as social media activity and web browsing logs—can accurately predict core human personality traits.

Ethos builds upon this foundational insight, expanding static digital footprint analysis into dynamic, real-time video consumption telemetry and modern generative AI topic modeling.

---

## 📁 Project Structure

```
Ethos/
├── src/                # React 19 frontend components, auth flows & dashboard UI
├── server.ts           # Primary Express backend server & Vite SSR/dev launcher
├── server/             # TypeScript server modules (MongoDB, BFI-44, Gemini AI, YouTube)
│   └── main.py         # FastAPI Python alternative backend server
├── extension/          # Manifest V3 Chrome Extension for event capture
├── ml/                 # Scikit-learn ML pipeline, LOOCV cross-validation & model artifacts
├── tests/              # End-to-end and ML lifecycle unit test suite
└── docs/               # Project documentation & audit reports
```

---

## 📄 License & Acknowledgments

Developed as a Major Capstone Project at **CMR Institute of Technology (CMRIT)**.
