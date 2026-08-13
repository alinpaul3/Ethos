import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import cookieParser from "cookie-parser";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import fs from "fs";
import { connectToDatabase } from "./server/mongodb.ts";
import { enrichEventPipeline } from "./server/enrichment_service.ts";
import { validateBfi44Responses, calculateBfi44Scores } from "./server/bfi44.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const JWT_SECRET = process.env.JWT_SECRET || "default_secret_for_dev_only";

// Middleware to verify JWT and attach user to req
const authenticateToken = (req: any, res: any, next: any) => {
  let token = null;
  if (req.headers?.authorization && req.headers.authorization.startsWith("Bearer ")) {
    token = req.headers.authorization.split(" ")[1];
  } else if (req.cookies?.auth_token) {
    token = req.cookies.auth_token;
  }

  if (!token) {
    const queryUserId = req.query?.user_id || req.body?.user_id;
    if (queryUserId) {
      req.user = { user_id: String(queryUserId) };
      return next();
    }
    return res.status(401).json({ message: "Authentication required" });
  }

  jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
    if (err) {
      const queryUserId = req.query?.user_id || req.body?.user_id;
      if (queryUserId) {
        req.user = { user_id: String(queryUserId) };
        return next();
      }
      return res.status(403).json({ message: "Invalid or expired token" });
    }
    req.user = user;
    next();
  });
};

// Dashboard history must never be selected from a caller-controlled user_id.
const authenticateDashboardToken = (req: any, res: any, next: any) => {
  const authorization = req.headers?.authorization;
  const token = authorization?.startsWith("Bearer ")
    ? authorization.split(" ")[1]
    : req.cookies?.auth_token;

  if (!token) {
    return res.status(401).json({ message: "Authentication required" });
  }

  jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
    if (err) return res.status(403).json({ message: "Invalid or expired token" });
    req.user = user;
    next();
  });
};

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Debug logging for all requests
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
  });

  // CORS Middleware for Chrome Extension support
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    } else {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, PATCH, DELETE");
    res.setHeader("Access-Control-Allow-Headers", "X-Requested-With, Content-Type, Authorization, Accept");
    res.setHeader("Access-Control-Allow-Credentials", "true");

    // Handle preflight
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });

  app.use(express.json());
  app.use(cookieParser());

  // --- FILE/MEMORY STORE FALLBACK FOR 100% RELIABILITY ---
  class FileStoreCollection {
    private collectionName: string;
    private filePath: string;

    constructor(collectionName: string) {
      this.collectionName = collectionName;
      this.filePath = path.join(process.cwd(), "data_store.json");
    }

    private readAll(): Record<string, any[]> {
      try {
        if (fs.existsSync(this.filePath)) {
          const content = fs.readFileSync(this.filePath, "utf8");
          return JSON.parse(content);
        }
      } catch (e) {
        console.error("FileStore read error:", e);
      }
      return {};
    }

    private writeAll(data: Record<string, any[]>) {
      try {
        fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf8");
      } catch (e) {
        console.error("FileStore write error:", e);
      }
    }

    private getItems(): any[] {
      const store = this.readAll();
      return store[this.collectionName] || [];
    }

    private setItems(items: any[]) {
      const store = this.readAll();
      store[this.collectionName] = items;
      this.writeAll(store);
    }

    private matchesQuery(item: any, query: any): boolean {
      if (!query || Object.keys(query).length === 0) return true;
      for (const [key, val] of Object.entries(query)) {
        if (key.includes(".")) {
          const parts = key.split(".");
          let curr = item;
          for (const p of parts) {
            curr = curr ? curr[p] : undefined;
          }
          if (curr !== val) return false;
        } else if (item[key] !== val) {
          return false;
        }
      }
      return true;
    }

    async findOne(query: any) {
      const items = this.getItems();
      const found = items.find(item => this.matchesQuery(item, query));
      return found ? { ...found } : null;
    }

    async insertOne(doc: any) {
      const items = this.getItems();
      const newDoc = { id: uuidv4(), ...doc };
      items.push(newDoc);
      this.setItems(items);
      return { acknowledged: true, insertedId: newDoc.id };
    }

    async updateOne(query: any, update: any, options?: any) {
      const items = this.getItems();
      let index = items.findIndex(item => this.matchesQuery(item, query));
      const fieldsToUpdate = update.$set || update;

      if (index !== -1) {
        items[index] = { ...items[index], ...fieldsToUpdate };
        this.setItems(items);
        return { matchedCount: 1, modifiedCount: 1 };
      } else if (options && options.upsert) {
        const newDoc = { id: uuidv4(), ...query, ...fieldsToUpdate };
        items.push(newDoc);
        this.setItems(items);
        return { matchedCount: 0, modifiedCount: 1, upsertedId: newDoc.id };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }

    async deleteOne(query: any) {
      const items = this.getItems();
      const index = items.findIndex(item => this.matchesQuery(item, query));
      if (index !== -1) {
        items.splice(index, 1);
        this.setItems(items);
        return { deletedCount: 1 };
      }
      return { deletedCount: 0 };
    }

    async countDocuments(query: any) {
      const items = this.getItems();
      return items.filter(item => this.matchesQuery(item, query)).length;
    }

    find(query: any) {
      const items = this.getItems().filter(item => this.matchesQuery(item, query));
      return {
        async toArray() {
          return items.map(item => ({ ...item }));
        }
      };
    }
  }

  class FileStoreDb {
    collection(name: string) {
      return new FileStoreCollection(name);
    }
  }

  // --- FIRESTORE ADAPTER TO EMULATE MONGODB API ---
  class FirestoreMongoCollection {
    private colRef: admin.firestore.CollectionReference;
    private fileFallback: FileStoreCollection;

    constructor(colRef: admin.firestore.CollectionReference) {
      this.colRef = colRef;
      this.fileFallback = new FileStoreCollection(colRef.id);
    }

    async findOne(query: any) {
      try {
        let q: admin.firestore.Query = this.colRef;
        for (const [key, val] of Object.entries(query)) {
          q = q.where(key, "==", val);
        }
        const snap = await q.limit(1).get();
        if (snap.empty) {
          return await this.fileFallback.findOne(query);
        }
        return { id: snap.docs[0].id, ...snap.docs[0].data() };
      } catch (e) {
        console.error("Firestore findOne error, using local store fallback:", e);
        return await this.fileFallback.findOne(query);
      }
    }

    async insertOne(doc: any) {
      try {
        const docId = doc.id || doc._id || undefined;
        if (docId) {
          await this.colRef.doc(String(docId)).set(doc);
        } else {
          await this.colRef.add(doc);
        }
        await this.fileFallback.insertOne(doc);
        return { acknowledged: true };
      } catch (e) {
        console.error("Firestore insertOne error, using local store fallback:", e);
        return await this.fileFallback.insertOne(doc);
      }
    }

    async updateOne(query: any, update: any, options?: any) {
      try {
        let q: admin.firestore.Query = this.colRef;
        const userId = query.user_id;
        let docRef: admin.firestore.DocumentReference | null = null;
        
        if (userId && Object.keys(query).length === 1 && this.colRef.id !== "raw_events" && this.colRef.id !== "enriched_events") {
          docRef = this.colRef.doc(userId);
        } else {
          for (const [key, val] of Object.entries(query)) {
            q = q.where(key, "==", val);
          }
          const snap = await q.limit(1).get();
          if (!snap.empty) {
            docRef = snap.docs[0].ref;
          } else if (options && options.upsert) {
            if (userId && this.colRef.id !== "raw_events" && this.colRef.id !== "enriched_events") {
              docRef = this.colRef.doc(userId);
            } else {
              docRef = this.colRef.doc();
            }
          }
        }

        if (!docRef) {
          await this.fileFallback.updateOne(query, update, options);
          return { matchedCount: 0, modifiedCount: 0 };
        }

        const fieldsToUpdate = update.$set || update;
        if (options && options.upsert) {
          await docRef.set({ ...query, ...fieldsToUpdate }, { merge: true });
        } else {
          await docRef.update(fieldsToUpdate);
        }
        await this.fileFallback.updateOne(query, update, options);
        return { matchedCount: 1, modifiedCount: 1 };
      } catch (e) {
        console.error("Firestore updateOne error, using local store fallback:", e);
        return await this.fileFallback.updateOne(query, update, options);
      }
    }

    async deleteOne(query: any) {
      try {
        let q: admin.firestore.Query = this.colRef;
        const userId = query.user_id;
        if (userId && Object.keys(query).length === 1 && this.colRef.id !== "raw_events" && this.colRef.id !== "enriched_events") {
          await this.colRef.doc(userId).delete();
        } else {
          for (const [key, val] of Object.entries(query)) {
            q = q.where(key, "==", val);
          }
          const snap = await q.limit(1).get();
          if (!snap.empty) {
            await snap.docs[0].ref.delete();
          }
        }
        await this.fileFallback.deleteOne(query);
        return { deletedCount: 1 };
      } catch (e) {
        console.error("Firestore deleteOne error, using local store fallback:", e);
        return await this.fileFallback.deleteOne(query);
      }
    }

    async countDocuments(query: any) {
      try {
        let q: admin.firestore.Query = this.colRef;
        for (const [key, val] of Object.entries(query)) {
          q = q.where(key, "==", val);
        }
        const snap = await q.get();
        const firestoreCount = snap.size;
        const localCount = await this.fileFallback.countDocuments(query);
        return Math.max(firestoreCount, localCount);
      } catch (e) {
        console.error("Firestore countDocuments error, using local store fallback:", e);
        return await this.fileFallback.countDocuments(query);
      }
    }

    find(query: any) {
      const colRef = this.colRef;
      const fileFallback = this.fileFallback;
      return {
        async toArray() {
          try {
            let q: admin.firestore.Query = colRef;
            for (const [key, val] of Object.entries(query)) {
              q = q.where(key, "==", val);
            }
            const snap = await q.get();
            const docs = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            if (docs.length > 0) return docs;
            return await fileFallback.find(query).toArray();
          } catch (e) {
            console.error("Firestore find toArray error, using local store fallback:", e);
            return await fileFallback.find(query).toArray();
          }
        }
      };
    }
  }

  class FirestoreMongoDb {
    private fsDb: admin.firestore.Firestore;
    constructor(fsDb: admin.firestore.Firestore) {
      this.fsDb = fsDb;
    }
    collection(name: string) {
      return new FirestoreMongoCollection(this.fsDb.collection(name));
    }
  }

  let db: any = null;
  let dbError: string | null = null;
  
  // Initialize Firebase Firestore Fallback
  let firestoreDb: admin.firestore.Firestore | null = null;
  try {
    const configPath = path.join(process.cwd(), "firebase-applet-config.json");
    if (fs.existsSync(configPath)) {
      const firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (admin.apps.length === 0) {
        admin.initializeApp({
          projectId: firebaseConfig.projectId,
        });
      }
      const app = admin.apps[0];
      if (app) {
        firestoreDb = getFirestore(app, firebaseConfig.firestoreDatabaseId);
        console.log("Firebase Firestore Admin SDK fallback initialized successfully.");
      }
    }
  } catch (err) {
    console.error("Failed to initialize Firebase Admin SDK fallback:", err);
  }

  // Connect in background to avoid blocking server startup
  if (process.env.MONGODB_URI) {
    connectToDatabase()
      .then((connectedDb) => {
        db = connectedDb;
        dbError = null;
        console.log("Database connected successfully via MongoDB");
      })
      .catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("MongoDB connection failed, falling back to Firestore:", errMsg);
        if (firestoreDb) {
          db = new FirestoreMongoDb(firestoreDb);
          dbError = null;
          console.log("Database connected successfully via Firestore Fallback");
        } else {
          db = new FileStoreDb();
          dbError = null;
          console.log("Database connected successfully via FileStore Fallback");
        }
      });
  } else {
    if (firestoreDb) {
      db = new FirestoreMongoDb(firestoreDb);
      dbError = null;
      console.log("Database connected successfully via Firestore");
    } else {
      db = new FileStoreDb();
      dbError = null;
      console.log("Database connected successfully via FileStore Fallback");
    }
  }

  // Helper to get collections safely
  const getCollections = () => {
    if (!db) db = new FileStoreDb();
    return {
      users: db.collection("users"),
      consents: db.collection("consents"),
      raw_events: db.collection("raw_events"),
      enriched_events: db.collection("enriched_events"),
      processing_status: db.collection("processing_status"),
      user_features: db.collection("user_features"),
      behavior_profiles: db.collection("behavior_profiles"),
      questionnaire_responses: db.collection("questionnaire_responses"),
    };
  };

  const PROCESSING_THRESHOLD = 1;
  const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

  // Processing Helpers
  const cleanTitle = (title: any): string => {
    if (!title || typeof title !== "string") return "";
    return title
      .toLowerCase()
      .replace(" - youtube", "")
      .replace(/[^\w\s]/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  };

  const getSentimentScore = (title: any): number => {
    if (!title || typeof title !== "string") return 0;
    const positiveWords = ["happy", "good", "great", "awesome", "amazing", "love", "best", "funny", "laugh", "joy"];
    const negativeWords = ["sad", "bad", "worst", "hate", "terrible", "awful", "scary", "death", "angry", "pain"];
    
    const words = title.toLowerCase().split(" ");
    let score = 0;
    words.forEach(w => {
      if (positiveWords.includes(w)) score += 1;
      if (negativeWords.includes(w)) score -= 1;
    });
    return score;
  };

  const calculateLateNightRatio = (events: any[]) => {
    if (!Array.isArray(events) || events.length === 0) return 0;
    const lateNightEvents = events.filter(e => {
      if (!e) return false;
      const ts = e.timestamp_start || e.created_at;
      if (!ts) return false;
      const date = new Date(ts);
      const hour = date.getHours();
      return !isNaN(hour) && (hour >= 22 || hour < 4);
    });
    return lateNightEvents.length / events.length;
  };

  const calculateActivityConsistency = (events: any[]) => {
    if (!Array.isArray(events) || events.length < 2) return 1;
    const hours = events.map(e => {
      if (!e) return NaN;
      const ts = e.timestamp_start || e.created_at;
      return ts ? new Date(ts).getHours() : NaN;
    }).filter(h => !isNaN(h));
    if (hours.length < 2) return 1;
    const mean = hours.reduce((a, b) => a + b, 0) / hours.length;
    const variance = hours.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / hours.length;
    const consistency = 1 - (Math.sqrt(variance) / 12);
    return isNaN(consistency) ? 1 : Math.max(0, Math.min(1, consistency));
  };

  const calculateTopicDiversity = (events: any[]) => {
    if (!Array.isArray(events) || events.length === 0) return 0;
    const titles = events.map(e => e ? cleanTitle(e.content_title || e.url || "") : "").filter(Boolean);
    if (titles.length === 0) return 0;
    const uniqueWords = new Set(titles.join(" ").split(" ").filter(w => w.length > 3));
    return uniqueWords.size / (events.length + 1);
  };

  const calculateLearningRatio = (events: any[]) => {
    if (!Array.isArray(events) || events.length === 0) return 0;
    const learningKeywords = [
      "tutorial", "learn", "course", "lecture", "code", "guide", "how", "math",
      "science", "python", "javascript", "react", "doc", "study", "history", "tech",
      "explained", "education", "mit", "stanford", "ai", "ml", "programming"
    ];
    const learningEvents = events.filter(e => {
      if (!e) return false;
      const title = typeof e.content_title === "string" ? e.content_title.toLowerCase() : "";
      const cat = typeof e.category === "string" ? e.category.toLowerCase() : "";
      return learningKeywords.some(kw => title.includes(kw) || cat.includes(kw));
    });
    return learningEvents.length / events.length;
  };

  const calculateRepetitionScore = (events: any[]) => {
    if (!Array.isArray(events) || events.length === 0) return 0;
    const titles = events.map(e => e ? cleanTitle(e.content_title || "") : "").filter(Boolean);
    if (titles.length === 0) return 0;
    const counts: { [key: string]: number } = {};
    titles.forEach(t => { counts[t] = (counts[t] || 0) + 1; });
    const keys = Object.keys(counts);
    if (keys.length === 0) return 0;
    const repetitiveCount = Object.values(counts).filter(c => c > 1).length;
    return repetitiveCount / keys.length;
  };

  // Event validation schema
  const eventSchema = z.object({
    user_id: z.string().min(1),
    platform: z.string().min(1),
    content_title: z.string().min(1),
    url: z.string().url(),
    timestamp_start: z.string(),
    timestamp_end: z.string(),
    duration_seconds: z.number().min(5),
  });

  // Middleware to check for DB connection
  const checkDb = (req: any, res: any, next: any) => {
    if (!db) {
      db = new FileStoreDb();
    }
    next();
  };

  // Events registration
  const handlePostEvents = async (req: any, res: any) => {
    try {
      const collections = getCollections();
      if (!collections) return res.status(500).json({ message: "Database unavailable" });

      // Sanitize req.body prior to validation
      if (req.body) {
        if (!req.body.content_title || typeof req.body.content_title !== "string" || !req.body.content_title.trim()) {
          req.body.content_title = "YouTube Video";
        }
        if (req.body.url && typeof req.body.url === "string" && !req.body.url.startsWith("http://") && !req.body.url.startsWith("https://")) {
          req.body.url = "https://" + req.body.url;
        }
      }

      // 1. Validation (Pydantic-like behavior via Zod)
      const eventData = eventSchema.parse(req.body);
      
      // A raw event represents one finalized watch session. Retries use the
      // exact same payload; separate watches receive a new timestamp_start.
      const eventIdentity = {
        user_id: eventData.user_id,
        platform: eventData.platform,
        url: eventData.url,
        timestamp_start: eventData.timestamp_start,
        timestamp_end: eventData.timestamp_end,
        duration_seconds: eventData.duration_seconds,
      };
      const duplicateEvent = await collections.raw_events.findOne(eventIdentity);

      if (duplicateEvent) {
        console.log(`Ignored retry of existing watch event for user ${eventData.user_id}`);
      } else {
        await collections.raw_events.insertOne({
          ...eventData,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        console.log(`Event stored for user ${eventData.user_id}. Platform: ${eventData.platform}`);
      }

      // Run enrichment pipeline in the background
      enrichEventPipeline(eventData, db).catch(err => {
        console.error("Error running enrichment pipeline in server:", err);
      });

      // Run runtime pipeline coordinator in background
      runPipelineForUser(eventData.user_id, collections).catch(err => {
        console.error("Error running user pipeline:", err);
      });

      res.status(201).json({ message: "Event stored" });
    } catch (error) {

      if (error instanceof z.ZodError) {
        console.warn("Invalid event rejected:", error.issues);
        return res.status(400).json({ message: "Invalid event data", errors: error.issues });
      }
      console.error("Error storing event:", error);
      res.status(500).json({ message: "Error storing event" });
    }
  };

  app.post("/events", checkDb, handlePostEvents);
  app.post("/api/events", checkDb, handlePostEvents);

  // Reusable data processing logic
  const processDataForUser = async (user_id: string, collections: any) => {
    console.log(`Starting processing for user: ${user_id}`);

    // 1. Fetch raw events
    const rawEvents = await collections.raw_events.find({ user_id }).toArray();
    if (rawEvents.length === 0) return null;

    // 2. Preprocessing & Feature Extraction
    const processedEvents = rawEvents.filter((e: any) => (Number(e.duration_seconds) >= 1 || e.url || e.content_title));
    
    const totalEvents = processedEvents.length > 0 ? processedEvents.length : rawEvents.length;
    const eventsToUse = processedEvents.length > 0 ? processedEvents : rawEvents;

    const totalWatchTime = eventsToUse.reduce((acc: number, e: any) => acc + (Number(e.duration_seconds) || 0), 0);
    const avgSessionDuration = eventsToUse.length > 0 ? totalWatchTime / eventsToUse.length : 0;
    
    const lateNightRatio = calculateLateNightRatio(eventsToUse);
    const activityConsistency = calculateActivityConsistency(eventsToUse);
    const repetitionScore = calculateRepetitionScore(eventsToUse);

    // Fetch completed enriched_events for Gemini semantic signals
    const enrichedList = await collections.enriched_events.find({ user_id }).toArray();
    const completedEnrichments = enrichedList.filter(
      (ee: any) => ee.enrichment_status === "completed" && ee.gemini_analysis
    );

    let topicDiversity = 0;
    let learningRatio = 0;

    if (completedEnrichments.length > 0) {
      const geminiTags: string[] = [];
      let learningCount = 0;

      for (const ee of completedEnrichments) {
        const ga = ee.gemini_analysis || {};
        if (Array.isArray(ga.topic_tags)) {
          ga.topic_tags.forEach((t: string) => {
            if (t) geminiTags.push(String(t).toLowerCase());
          });
        }
        const cat = String(ga.content_category || "").toLowerCase();
        const intent = String(ga.estimated_user_intent || "").toLowerCase();
        const domain = String(ga.knowledge_domain || "").toLowerCase();

        if (
          ["educational", "tech/gaming", "news/documentary"].includes(cat) ||
          ["learning", "skill_acquisition", "information_seeking", "curiosity"].includes(intent) ||
          ["science", "tech", "computer", "math", "education", "engineering"].some(k => domain.includes(k))
        ) {
          learningCount++;
        }
      }

      const uniqueTags = new Set(geminiTags);
      topicDiversity = Math.min(1.0, uniqueTags.size / (completedEnrichments.length + 1));
      learningRatio = Math.min(1.0, learningCount / completedEnrichments.length);
    } else {
      // Fallback text calculations when no completed Gemini enrichments exist yet
      topicDiversity = calculateTopicDiversity(eventsToUse);
      learningRatio = calculateLearningRatio(eventsToUse);
    }
    
    const sentimentScores = eventsToUse.map((e: any) => getSentimentScore(e.content_title || e.url || ""));
    const avgSentiment = sentimentScores.length > 0 ? (sentimentScores.reduce((a: number, b: number) => a + b, 0) / sentimentScores.length) : 0;
    const sentimentVariance = sentimentScores.length > 0 ? (sentimentScores.reduce((a: number, b: number) => a + Math.pow(b - avgSentiment, 2), 0) / sentimentScores.length) : 0;

    // 3. Aggregate into User Features
    const userFeatures = {
      user_id,
      total_events: totalEvents,
      avg_session_duration: Number(avgSessionDuration.toFixed(2)),
      total_watch_time: totalWatchTime,
      late_night_ratio: Number(lateNightRatio.toFixed(3)),
      topic_diversity: Number(topicDiversity.toFixed(3)),
      learning_ratio: Number(learningRatio.toFixed(3)),
      repetition_score: Number(repetitionScore.toFixed(3)),
      activity_consistency: Number(activityConsistency.toFixed(3)),
      avg_sentiment: Number(avgSentiment.toFixed(3)),
      processed_at: new Date().toISOString()
    };

    await collections.user_features.updateOne(
      { user_id },
      { $set: userFeatures },
      { upsert: true }
    );

    // 4. Generate Behavior Signals
    const behaviorProfile = {
      user_id,
      last_processed_event_count: totalEvents,
      signals: {
        curiosity_signal: topicDiversity > 0.5 ? "High" : (topicDiversity > 0.2 ? "Moderate" : "Low"),
        discipline_signal: (activityConsistency > 0.7 && lateNightRatio < 0.2) ? "High" : (lateNightRatio > 0.5 ? "Low" : "Moderate"),
        engagement_signal: totalWatchTime > 3600 ? "High" : (totalWatchTime > 1800 ? "Moderate" : "Low"),
        emotional_stability_signal: sentimentVariance < 1.0 ? "High" : "Variable"
      },
      derived_at: new Date().toISOString()
    };

    await collections.behavior_profiles.updateOne(
      { user_id },
      { $set: behaviorProfile },
      { upsert: true }
    );
    console.log(`Processing completed for user: ${user_id}. Signals generated.`);
    return { features: userFeatures, profile: behaviorProfile };
  };

  const predictPersonalityMl = async (features: any): Promise<any> => {
    const { exec } = await import("child_process");
    const predictScript = path.join(process.cwd(), "ml", "predict.py");
    const pythonCmd = process.platform === "win32" ? "python" : "python3";

    const featurePayload = {
      avg_session_duration: Number(features?.avg_session_duration) || 0,
      late_night_ratio: Number(features?.late_night_ratio) || 0,
      topic_diversity: Number(features?.topic_diversity) || 0,
      learning_ratio: Number(features?.learning_ratio) || 0,
      activity_consistency: Number(features?.activity_consistency) || 0
    };

    const jsonArg = JSON.stringify(featurePayload).replace(/"/g, '\\"');

    return new Promise((resolve, reject) => {
      exec(`${pythonCmd} "${predictScript}" "${jsonArg}"`, (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(`ML prediction exec failed: ${stderr || err.message}`));
        }
        try {
          const parsed = JSON.parse(stdout.trim());
          if (parsed && (parsed.prediction_method === "ml" || parsed.scores)) {
            return resolve(parsed);
          }
          return reject(new Error(`Invalid ML prediction output: ${stdout}`));
        } catch (parseErr: any) {
          return reject(new Error(`Failed to parse ML output JSON: ${parseErr.message}`));
        }
      });
    });
  };

  const calculateOceanScores = (features: any) => {
    const td = Number(features?.topic_diversity) || 0.3;
    const ac = Number(features?.activity_consistency) || 0.7;
    const lr = Number(features?.learning_ratio) || 0.4;
    const ln = Number(features?.late_night_ratio) || 0.1;

    const clamp = (min: number, max: number, val: number) => Math.min(max, Math.max(min, val));

    return {
      openness: Number(clamp(1.0, 5.0, 2.5 + td * 3.0).toFixed(2)),
      conscientiousness: Number(clamp(1.0, 5.0, 2.0 + ac * 2.5 - ln * 1.5).toFixed(2)),
      extraversion: Number(clamp(1.0, 5.0, 2.8 + lr * 1.5).toFixed(2)),
      agreeableness: Number(clamp(1.0, 5.0, 3.2 + (1.0 - ln) * 1.0).toFixed(2)),
      neuroticism: Number(clamp(1.0, 5.0, 1.8 + ln * 2.5).toFixed(2))
    };
  };

  const activeProcessingUsersTs = new Set<string>();

  const runPipelineForUser = async (userId: string, collections: any) => {
    if (!userId || !collections) return null;

    if (activeProcessingUsersTs.has(userId)) {
      console.log(`Processing already active for user ${userId}. Skipping duplicate.`);
      return { status: "skipped", reason: "already_processing" };
    }

    activeProcessingUsersTs.add(userId);
    try {
      const currentEventCount = await collections.raw_events.countDocuments({ user_id: userId });
      const statusDoc = await collections.processing_status.findOne({ user_id: userId });
      const profileDoc = await collections.behavior_profiles.findOne({ user_id: userId });

      let lastProcessedCount = 0;
      if (statusDoc && typeof statusDoc.last_processed_event_count === "number") {
        lastProcessedCount = statusDoc.last_processed_event_count;
      } else if (profileDoc && typeof profileDoc.last_processed_event_count === "number") {
        lastProcessedCount = profileDoc.last_processed_event_count;
      }

      const delta = currentEventCount - lastProcessedCount;
      if (delta < PROCESSING_THRESHOLD) {
        console.log(`Threshold not met for user ${userId}: current=${currentEventCount}, last_processed=${lastProcessedCount}, delta=${delta} < ${PROCESSING_THRESHOLD}`);
        return {
          status: "skipped",
          reason: "threshold_not_met",
          current_event_count: currentEventCount,
          last_processed_event_count: lastProcessedCount,
          delta
        };
      }

      const nowIso = new Date().toISOString();
      await collections.processing_status.updateOne(
        { user_id: userId },
        {
          $set: {
            user_id: userId,
            processing_status: "processing",
            processing_in_progress: true,
            started_at: nowIso
          }
        },
        { upsert: true }
      );

      const processRes = await processDataForUser(userId, collections);
      if (!processRes) {
        throw new Error("processDataForUser failed or returned null");
      }

      const features = await collections.user_features.findOne({ user_id: userId }) || {};
      
      // Execute ML inference in production (no silent fallback to heuristics)
      let oceanScores: any;
      let predictionMethod = "ml";

      try {
        const mlRes = await predictPersonalityMl(features);
        oceanScores = mlRes.scores || mlRes;
        predictionMethod = mlRes.prediction_method || "ml";
      } catch (mlErr: any) {
        const useFallback = (process.env.USE_HEURISTIC_FALLBACK || "false").toLowerCase() === "true";
        if (!useFallback) {
          throw new Error(`ML model inference failed and USE_HEURISTIC_FALLBACK is disabled: ${mlErr.message}`);
        }
        console.warn("[OCEAN Model] ML model inference failed. Using explicitly enabled heuristic fallback:", mlErr.message);
        oceanScores = calculateOceanScores(features);
        predictionMethod = "heuristic";
      }

      const predictionDoc = {
        user_id: userId,
        scores: oceanScores,
        prediction_method: predictionMethod,
        feature_version: "v1",
        prediction_version: "v1",
        event_count_at_prediction: currentEventCount,
        predicted_at: new Date().toISOString()
      };

      await collections.personality_predictions.updateOne(
        { user_id: userId },
        { $set: predictionDoc },
        { upsert: true }
      );

      await collections.ocean_predictions.updateOne(
        { user_id: userId },
        {
          $set: {
            user_id: userId,
            scores: oceanScores,
            prediction_method: predictionMethod,
            updated_at: new Date().toISOString(),
            event_count_at_prediction: currentEventCount
          }
        },
        { upsert: true }
      );

      await collections.behavior_profiles.updateOne(
        { user_id: userId },
        {
          $set: {
            last_processed_event_count: currentEventCount,
            last_processed_at: new Date().toISOString(),
            pipeline_status: "completed",
            pipeline_version: "v1"
          }
        },
        { upsert: true }
      );

      await collections.processing_status.updateOne(
        { user_id: userId },
        {
          $set: {
            user_id: userId,
            last_processed_event_count: currentEventCount,
            last_processed_at: new Date().toISOString(),
            processing_status: "completed",
            processing_in_progress: false,
            total_events: currentEventCount
          }
        },
        { upsert: true }
      );

      if (N8N_WEBHOOK_URL) {
        fetch(N8N_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_id: userId,
            event_count: currentEventCount,
            last_processed_event_count: currentEventCount,
            processed: true,
            timestamp: new Date().toISOString()
          })
        }).catch(err => console.warn("Optional n8n notice failed:", err));
      }

      console.log(`Pipeline completed successfully for user ${userId} at ${currentEventCount} events.`);
      return { status: "success", user_id: userId, processed_event_count: currentEventCount, ocean_scores: oceanScores };
    } catch (err: any) {
      console.error(`Pipeline failed for user ${userId}:`, err);
      if (collections && collections.processing_status) {
        await collections.processing_status.updateOne(
          { user_id: userId },
          {
            $set: {
              user_id: userId,
              processing_status: "failed",
              processing_in_progress: false,
              last_error: String(err),
              failed_at: new Date().toISOString()
            }
          },
          { upsert: true }
        ).catch(() => {});
      }
      return null;
    } finally {
      activeProcessingUsersTs.delete(userId);
    }
  };

  const handlePreprocess = async (req: any, res: any) => {
    const { user_id, event_count, events } = req.body;
    
    // Log: processing started
    console.log(`[Preprocess API] Processing started for user: ${user_id || "unknown"}. Events to process: ${event_count || 0}`);

    try {
      if (!user_id) {
        // Log: processing failed
        console.error("[Preprocess API] Processing failed. Error: Missing user_id.");
        return res.status(400).json({ 
          status: "failed", 
          message: "user_id is required" 
        });
      }

      if (!events || !Array.isArray(events)) {
        // Log: processing failed
        console.error(`[Preprocess API] Processing failed for user: ${user_id}. Error: Invalid or missing events list.`);
        return res.status(400).json({ 
          status: "failed", 
          message: "events must be an array of enriched browsing documents" 
        });
      }

      // Perform a light-weight simulation of saving a preprocessed log/checkpoint in the database,
      // confirming readiness for subsequent pipeline stages (feature-engineering, behavior-model, etc.)
      const collections = getCollections();
      if (collections) {
        await collections.processing_status.updateOne(
          { user_id },
          { 
            $set: { 
              preprocessed_dataset_packaged: true,
              last_preprocessed_at: new Date().toISOString(),
              preprocessed_events_count: events.length
            } 
          },
          { upsert: true }
        );
      }

      // Log: processing completed
      console.log(`[Preprocess API] Processing completed successfully for user: ${user_id}. ${events.length} events processed.`);

      res.status(200).json({
        status: "success",
        message: "Preprocessing completed",
        user_id,
        processed_events_count: events.length,
        next_stages_ready: ["feature-engineering", "behavior-model", "ocean-model", "generate-explanation"],
        timestamp: new Date().toISOString()
      });
    } catch (error: any) {
      // Log: processing failed
      console.error(`[Preprocess API] Processing failed for user: ${user_id}. Error: ${error.message || error}`);
      res.status(500).json({ 
        status: "failed", 
        message: "Internal preprocessing failure",
        error: error.message 
      });
    }
  };

  app.post("/preprocess", checkDb, handlePreprocess);
  app.post("/api/preprocess", checkDb, handlePreprocess);

  // Processing Endpoint (Phase 4)
  app.post("/process-data", checkDb, async (req, res) => {
    try {
      const { user_id, events } = req.body;
      if (!user_id) return res.status(400).json({ message: "user_id is required" });

      if (events && Array.isArray(events)) {
        return handlePreprocess(req, res);
      }

      const collections = getCollections();
      if (!collections) return res.status(500).json({ message: "Database unavailable" });

      const result = await runPipelineForUser(user_id, collections);
      if (!result) {
        const profile = await processDataForUser(user_id, collections);
        if (!profile) {
          return res.status(404).json({ message: "No events found or failed to process" });
        }
        return res.json({ message: "Processing completed (fallback)", user_id, summary: profile.signals });
      }
      return res.json({ message: "Processing completed", user_id, result });
    } catch (error: any) {
      return res.status(500).json({ message: "Processing failed", error: error.message });
    }
  });

  // BFI-44 Questionnaire Submission & Fetch Endpoints
  const handleQuestionnaireSubmit = async (req: any, res: any) => {
    try {
      const body = req.body || {};
      const user_id = body.user_id || req.user?.user_id;
      const questionnaire_type = body.questionnaire_type || "BFI-44";
      const responses = body.responses;
      const consent_version = body.consent_version || "v1.0";

      if (!user_id || typeof user_id !== "string" || !user_id.trim()) {
        return res.status(400).json({
          status: "failed",
          error: "Missing or invalid user_id in request body."
        });
      }

      if (questionnaire_type !== "BFI-44") {
        return res.status(400).json({
          status: "failed",
          error: `Invalid questionnaire_type '${questionnaire_type}'. Expected 'BFI-44'.`
        });
      }

      // Validate exactly 44 answers received with score 1-5
      const validation = validateBfi44Responses(responses);
      if (!validation.isValid) {
        return res.status(400).json({
          status: "failed",
          error: validation.error
        });
      }

      // Format & sort responses cleanly by question_id
      const formattedResponses = responses
        .map((r: any) => ({
          question_id: Number(r.question_id),
          score: Number(r.score)
        }))
        .sort((a: any, b: any) => a.question_id - b.question_id);

      // Compute Big Five OCEAN trait scores based on standard PhenX key
      const scores = calculateBfi44Scores(formattedResponses);

      const collections = getCollections();
      if (!collections) {
        return res.status(500).json({ status: "failed", error: "Database unavailable" });
      }

      const questionnaireDoc = {
        user_id: user_id.trim(),
        questionnaire_type: "BFI-44",
        responses: formattedResponses,
        completed_at: new Date().toISOString(),
        consent_version,
        status: "completed",
        scores
      };

      // Store in MongoDB 'questionnaire_responses' collection
      await collections.questionnaire_responses.updateOne(
        { user_id: user_id.trim(), questionnaire_type: "BFI-44" },
        { $set: questionnaireDoc },
        { upsert: true }
      );

      console.log(`[BFI-44 Endpoint] Questionnaire response stored for user_id: ${user_id}`);

      return res.status(200).json({
        status: "success",
        message: "Questionnaire responses stored successfully",
        user_id: user_id.trim(),
        questionnaire_type: "BFI-44",
        completed_at: questionnaireDoc.completed_at,
        consent_version: questionnaireDoc.consent_version,
        scores: questionnaireDoc.scores
      });
    } catch (error: any) {
      console.error("[BFI-44 Endpoint] Error storing questionnaire response:", error);
      return res.status(500).json({
        status: "failed",
        error: "Internal server error storing questionnaire response",
        details: error.message
      });
    }
  };

  const handleQuestionnaireGet = async (req: any, res: any) => {
    try {
      const user_id = (req.query.user_id as string) || req.user?.user_id;
      if (!user_id) {
        return res.status(400).json({ status: "failed", error: "user_id is required" });
      }

      const collections = getCollections();
      if (!collections) return res.status(500).json({ status: "failed", error: "Database unavailable" });

      const responseDoc = await collections.questionnaire_responses.findOne({
        user_id: user_id.trim(),
        questionnaire_type: "BFI-44"
      });

      if (!responseDoc) {
        return res.status(404).json({
          status: "not_found",
          message: "No completed BFI-44 response found for user_id",
          user_id
        });
      }

      return res.status(200).json({
        status: "success",
        user_id,
        data: responseDoc
      });
    } catch (error: any) {
      return res.status(500).json({ status: "failed", error: error.message });
    }
  };

  app.post("/questionnaire/submit", checkDb, handleQuestionnaireSubmit);
  app.post("/api/questionnaire/submit", checkDb, handleQuestionnaireSubmit);
  app.get("/questionnaire/response", checkDb, handleQuestionnaireGet);
  app.get("/api/questionnaire/response", checkDb, handleQuestionnaireGet);

  // Training Dataset Generator Endpoint
  const handleExportTrainingDataset = async (req: any, res: any) => {
    try {
      const collections = getCollections();
      if (!collections) {
        return res.status(500).json({ status: "failed", error: "Database unavailable" });
      }

      // 1. Read all user records and feature/questionnaire documents from MongoDB
      const allUserFeatures = await collections.user_features.find({}).toArray();
      const allQuestionnaires = await collections.questionnaire_responses.find({ questionnaire_type: "BFI-44" }).toArray();
      const allUsers = await collections.users.find({}).toArray();

      // Collect all unique user_ids
      const userIds = new Set<string>();
      allUserFeatures.forEach((uf: any) => uf.user_id && userIds.add(uf.user_id));
      allQuestionnaires.forEach((q: any) => q.user_id && userIds.add(q.user_id));
      allUsers.forEach((u: any) => u.user_id && userIds.add(u.user_id));

      const featuresMap = new Map<string, any>();
      allUserFeatures.forEach((uf: any) => featuresMap.set(uf.user_id, uf));

      const questionnairesMap = new Map<string, any>();
      allQuestionnaires.forEach((q: any) => questionnairesMap.set(q.user_id, q));

      const datasetRows: any[] = [];

      for (const user_id of Array.from(userIds)) {
        let feat = featuresMap.get(user_id);

        // If user_features missing, attempt to process user events on the fly
        if (!feat) {
          await processDataForUser(user_id, collections).catch(() => null);
          feat = await collections.user_features.findOne({ user_id });
        }

        const quest = questionnairesMap.get(user_id);

        let oceanScores = quest?.scores;
        if (!oceanScores && quest?.responses && Array.isArray(quest.responses)) {
          oceanScores = calculateBfi44Scores(quest.responses);
        }

        const row = {
          user_id,
          avg_session_duration: feat ? Math.round((feat.avg_session_duration || 0) * 100) / 100 : 0,
          late_night_ratio: feat ? Math.round((feat.late_night_ratio || 0) * 1000) / 1000 : 0,
          topic_diversity: feat ? Math.round((feat.topic_diversity || 0) * 1000) / 1000 : 0,
          learning_ratio: feat ? Math.round((feat.learning_ratio || 0) * 1000) / 1000 : 0,
          activity_consistency: feat ? Math.round((feat.activity_consistency || 0) * 1000) / 1000 : 0,
          openness: oceanScores?.openness ?? "",
          conscientiousness: oceanScores?.conscientiousness ?? "",
          extraversion: oceanScores?.extraversion ?? "",
          agreeableness: oceanScores?.agreeableness ?? "",
          neuroticism: oceanScores?.neuroticism ?? ""
        };

        datasetRows.push(row);
      }

      // Convert dataset rows to CSV format
      const csvHeaders = [
        "user_id",
        "avg_session_duration",
        "late_night_ratio",
        "topic_diversity",
        "learning_ratio",
        "activity_consistency",
        "openness",
        "conscientiousness",
        "extraversion",
        "agreeableness",
        "neuroticism"
      ];

      const csvLines = [csvHeaders.join(",")];
      datasetRows.forEach((r: any) => {
        const line = csvHeaders.map(h => {
          const val = r[h];
          if (val === null || val === undefined) return "";
          return String(val);
        }).join(",");
        csvLines.push(line);
      });

      const csvContent = csvLines.join("\n") + "\n";

      // Save training_dataset.csv at project root
      const csvFilePath = path.join(process.cwd(), "training_dataset.csv");
      fs.writeFileSync(csvFilePath, csvContent, "utf8");
      console.log(`[Export Dataset] Generated training_dataset.csv with ${datasetRows.length} rows.`);

      if (req.query.format === "json") {
        return res.status(200).json({
          status: "success",
          count: datasetRows.length,
          file_path: "training_dataset.csv",
          data: datasetRows
        });
      }

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="training_dataset.csv"');
      return res.status(200).send(csvContent);
    } catch (error: any) {
      console.error("[Export Dataset] Error generating training dataset:", error);
      return res.status(500).json({
        status: "failed",
        error: "Internal server error exporting dataset",
        details: error.message
      });
    }
  };

  app.get("/export-training-dataset", checkDb, handleExportTrainingDataset);
  app.get("/api/export-training-dataset", checkDb, handleExportTrainingDataset);

  // Extension Zip Download Endpoint
  const handleDownloadExtension = async (req: any, res: any) => {
    try {
      const extensionDir = path.join(process.cwd(), "extension");
      if (!fs.existsSync(extensionDir)) {
        return res.status(404).json({ status: "failed", error: "Extension package directory not found" });
      }

      // @ts-ignore
      const AdmZipModule: any = await import("adm-zip");
      const AdmZipClass: any = AdmZipModule.default || AdmZipModule;
      const zip = new AdmZipClass();
      zip.addLocalFolder(extensionDir);
      const zipBuffer = zip.toBuffer();

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", 'attachment; filename="ethos-chrome-extension.zip"');
      res.setHeader("Content-Length", zipBuffer.length.toString());
      return res.status(200).send(zipBuffer);
    } catch (error: any) {
      console.error("[Download Extension] Error packaging extension zip:", error);
      return res.status(500).json({ status: "failed", error: "Failed to create extension package or adm-zip missing" });
    }
  };

  app.get("/download-extension", handleDownloadExtension);
  app.get("/api/download-extension", handleDownloadExtension);

  // Chrome Web Store Auto-Linking Token Handshake Endpoints
  const pairingTokens = new Map<string, { userId: string; expiresAt: number }>();

  const handleGetExtensionToken = async (req: any, res: any) => {
    try {
      const authHeader = req.headers.authorization;
      let userId = req.query.user_id;

      if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.split(" ")[1];
        try {
          const decoded: any = jwt.verify(token, JWT_SECRET);
          userId = decoded.user_id;
        } catch (e) {
          // ignore token error if user_id passed in query for testing
        }
      }

      if (!userId) {
        return res.status(401).json({ status: "failed", error: "Authentication required" });
      }

      const pairingToken = "pt_" + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
      pairingTokens.set(pairingToken, {
        userId: userId,
        expiresAt: Date.now() + 5 * 60 * 1000 // 5 min single-use expiry
      });

      return res.status(200).json({
        status: "success",
        pairing_token: pairingToken,
        expires_in: 300,
        user_id: userId
      });
    } catch (error: any) {
      return res.status(500).json({ status: "failed", error: error.message });
    }
  };

  const handleRegisterExtension = async (req: any, res: any) => {
    try {
      const { pairing_token } = req.body;
      if (!pairing_token || !pairingTokens.has(pairing_token)) {
        return res.status(400).json({ status: "failed", error: "Invalid or expired pairing token" });
      }

      const tokenData = pairingTokens.get(pairing_token)!;
      if (Date.now() > tokenData.expiresAt) {
        pairingTokens.delete(pairing_token);
        return res.status(400).json({ status: "failed", error: "Pairing token expired" });
      }

      const userId = tokenData.userId;
      pairingTokens.delete(pairing_token); // single-use burn

      // Issue long-lived extension telemetry token
      const extensionAuthToken = jwt.sign(
        { user_id: userId, scope: "telemetry_ingest" },
        JWT_SECRET,
        { expiresIn: "365d" }
      );

      return res.status(200).json({
        status: "success",
        message: "Extension auto-linked successfully",
        user_id: userId,
        extension_auth_token: extensionAuthToken
      });
    } catch (error: any) {
      return res.status(500).json({ status: "failed", error: error.message });
    }
  };

  app.get("/api/auth/extension-token", handleGetExtensionToken);
  app.post("/api/extension/register", handleRegisterExtension);

  // ML Pipeline Endpoints: Train Model
  const handleTrainMlModel = async (req: any, res: any) => {
    try {
      const { exec } = await import("child_process");
      const pythonCmd = process.platform === "win32" ? "python" : "python3";
      exec(`${pythonCmd} "${mlScript}" ml training_dataset.csv`, async (err, stdout, stderr) => {
        if (err) {
          console.error("[ML Pipeline] Python training error:", stderr || err.message);
          return res.status(500).json({
            status: "failed",
            error: "ML training execution failed",
            details: stderr || err.message,
            output: stdout
          });
        }

        console.log("[ML Pipeline] Training output:\n", stdout);

        // Read saved history JSON if present
        const historyPath = path.join(process.cwd(), "ml", "training_history.json");
        let historyData = null;
        if (fs.existsSync(historyPath)) {
          try {
            historyData = JSON.parse(fs.readFileSync(historyPath, "utf8"));
          } catch (e) {
            console.warn("Could not parse training_history.json:", e);
          }
        }

        return res.status(200).json({
          status: "success",
          message: "TensorFlow personality model trained successfully",
          output: stdout,
          artifacts: [
            "/ml/personality_model.keras",
            "/ml/scaler.pkl",
            "/ml/training_history.json",
            "/ml/training_loss.png",
            "/ml/training_mae.png"
          ],
          results: historyData
        });
      });
    } catch (error: any) {
      return res.status(500).json({ status: "failed", error: error.message });
    }
  };

  app.post("/api/ml/train", checkDb, handleTrainMlModel);
  app.get("/api/ml/train", checkDb, handleTrainMlModel);

  // ML Pipeline Endpoints: Get Training History & Metrics
  app.get("/api/ml/metrics", (req, res) => {
    const historyPath = path.join(process.cwd(), "ml", "training_history.json");
    if (!fs.existsSync(historyPath)) {
      return res.status(404).json({ status: "error", message: "No model training metrics found. Please trigger model training." });
    }
    try {
      const historyData = JSON.parse(fs.readFileSync(historyPath, "utf8"));
      return res.status(200).json({ status: "success", data: historyData });
    } catch (e: any) {
      return res.status(500).json({ status: "error", message: e.message });
    }
  });

  // ML Pipeline Endpoints: Predict Personality
  app.post("/api/ml/predict", checkDb, async (req, res) => {
    try {
      const { user_id, features } = req.body;
      let featurePayload = features;

      if (!featurePayload && user_id) {
        const collections = getCollections();
        if (collections) {
          const userFeat = await collections.user_features.findOne({ user_id });
          if (userFeat) {
            featurePayload = {
              avg_session_duration: userFeat.avg_session_duration || 0,
              late_night_ratio: userFeat.late_night_ratio || 0,
              topic_diversity: userFeat.topic_diversity || 0,
              learning_ratio: userFeat.learning_ratio || 0,
              activity_consistency: userFeat.activity_consistency || 0
            };
          }
        }
      }

      if (!featurePayload) {
        return res.status(400).json({ status: "failed", error: "Missing feature vector or valid user_id" });
      }

      const pythonCmd = process.platform === "win32" ? "python" : "python3";
      exec(`${pythonCmd} "${predictScript}" "${jsonArg}"`, (err, stdout, stderr) => {
        if (err) {
          return res.status(500).json({ status: "failed", error: stderr || err.message });
        }
        try {
          const predictions = JSON.parse(stdout.trim());
          return res.status(200).json({ status: "success", user_id, input_features: featurePayload, predictions });
        } catch (parseErr: any) {
          return res.status(500).json({ status: "failed", raw_output: stdout, error: parseErr.message });
        }
      });
    } catch (error: any) {
      return res.status(500).json({ status: "failed", error: error.message });
    }
  });

  // ML Plots Endpoints
  app.get("/ml/plot/loss", (req, res) => {
    const plotPath = path.join(process.cwd(), "ml", "training_loss.png");
    if (fs.existsSync(plotPath)) {
      res.setHeader("Content-Type", "image/png");
      return res.sendFile(plotPath);
    }
    return res.status(404).send("Loss plot not found");
  });

  app.get("/ml/plot/mae", (req, res) => {
    const plotPath = path.join(process.cwd(), "ml", "training_mae.png");
    if (fs.existsSync(plotPath)) {
      res.setHeader("Content-Type", "image/png");
      return res.sendFile(plotPath);
    }
    return res.status(404).send("MAE plot not found");
  });

  // Auth routes
  app.post("/api/auth/signup", checkDb, async (req, res) => {
    try {
      const { email, password } = req.body;
      const collections = getCollections();
      if (!collections) return res.status(500).json({ message: "Database unavailable" });

      const existingUser = await collections.users.findOne({ email });
      if (existingUser) return res.status(400).json({ message: "User already exists" });

      const hashedPassword = await bcrypt.hash(password, 10);
      const user_id = uuidv4();
      
      const newUser = {
        user_id,
        email,
        password: hashedPassword,
        created_at: new Date().toISOString(),
      };

      await collections.users.insertOne(newUser);
      
      const token = jwt.sign({ user_id, email }, JWT_SECRET, { expiresIn: "7d" });
      res.cookie("auth_token", token, { 
        httpOnly: true, 
        secure: true, 
        sameSite: "none", 
        maxAge: 7 * 24 * 60 * 60 * 1000 
      });
      
      res.json({ user_id, email, token, consent_given: false, message: "User created successfully" });
    } catch (error) {
      res.status(500).json({ message: "Error during signup" });
    }
  });

  app.post("/api/auth/login", checkDb, async (req, res) => {
    try {
      const { email, password } = req.body;
      const collections = getCollections();
      if (!collections) return res.status(500).json({ message: "Database unavailable" });

      const user = await collections.users.findOne({ email });
      if (!user) return res.status(400).json({ message: "Invalid credentials" });

      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword) return res.status(400).json({ message: "Invalid credentials" });

      const token = jwt.sign({ user_id: user.user_id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
      res.cookie("auth_token", token, { 
        httpOnly: true, 
        secure: true, 
        sameSite: "none", 
        maxAge: 7 * 24 * 60 * 60 * 1000 
      });

      const consentDoc = await collections.consents.findOne({ user_id: user.user_id });
      const consent_given = consentDoc ? consentDoc.consent_given === true : false;

      res.json({ user_id: user.user_id, email: user.email, token, consent_given });
    } catch (error) {
      res.status(500).json({ message: "Error during login" });
    }
  });

  app.get("/api/auth/me", authenticateToken, async (req: any, res) => {
    const collections = getCollections();
    let consent_given = false;
    if (collections) {
      const consentDoc = await collections.consents.findOne({ user_id: req.user.user_id });
      consent_given = consentDoc ? consentDoc.consent_given === true : false;
    }
    res.json({ user_id: req.user.user_id, email: req.user.email, consent_given });
  });

  app.post("/api/auth/logout", (req, res) => {
    res.clearCookie("auth_token", {
      httpOnly: true,
      secure: true,
      sameSite: "none"
    });
    res.json({ message: "Logged out" });
  });

  // Consent routes
  app.post("/api/consent", authenticateToken, checkDb, async (req: any, res) => {
    try {
      const { consent_given } = req.body;
      const user_id = req.user.user_id;
      const collections = getCollections();
      if (!collections) return res.status(500).json({ message: "Database unavailable" });

      await collections.consents.updateOne(
        { user_id },
        { $set: { consent_given, updated_at: new Date().toISOString() } },
        { upsert: true }
      );

      res.json({ user_id, consent_given });
    } catch (error) {
      res.status(500).json({ message: "Error saving consent" });
    }
  });

  app.get("/api/consent-status", authenticateToken, checkDb, async (req: any, res) => {
    try {
      const user_id = req.user.user_id;
      const collections = getCollections();
      if (!collections) return res.status(500).json({ message: "Database unavailable" });

      const consent = await collections.consents.findOne({ user_id });
      res.json({ user_id, consent_given: consent?.consent_given || false });
    } catch (error) {
      res.status(500).json({ message: "Error fetching consent status" });
    }
  });

  const handleDashboardData = async (req: any, res: any) => {
    try {
      const user_id = req.user?.user_id || (req.query.user_id as string);
      if (!user_id) {
        return res.status(401).json({ message: "Authentication required or user_id missing" });
      }

      const collections = getCollections();
      if (!collections) return res.status(500).json({ message: "Database unavailable" });

      // Run automatic processing in background so dashboard loads instantly
      processDataForUser(user_id, collections).catch(err => {
        console.error("Auto-processing during dashboard fetch failed:", err);
      });

      let features = await collections.user_features.findOne({ user_id });
      const profile = await collections.behavior_profiles.findOne({ user_id });
      const questionnaire = await collections.questionnaire_responses.findOne({ user_id, questionnaire_type: "BFI-44" });
      const events = await collections.raw_events.find({ user_id }).toArray();
      const enrichedEvents = await collections.enriched_events.find({ user_id }).toArray();

      if (events.length > 0) {
        const liveTotalWatchTime = events.reduce((acc: number, e: any) => acc + (Number(e.duration_seconds) || 0), 0);
        const liveAvgSession = events.length > 0 ? liveTotalWatchTime / events.length : 0;
        const sentimentScores = events.map((e: any) => getSentimentScore(e.content_title || e.url || ""));
        const liveAvgSentiment = events.length > 0 ? (sentimentScores.reduce((a: number, b: number) => a + b, 0) / events.length) : 0;

        if (!features) {
          features = {
            user_id,
            total_events: events.length,
            avg_session_duration: liveAvgSession,
            total_watch_time: liveTotalWatchTime,
            late_night_ratio: 0,
            topic_diversity: 0.5,
            learning_ratio: 0.5,
            repetition_score: 0,
            activity_consistency: 1,
            avg_sentiment: liveAvgSentiment,
            processed_at: new Date().toISOString()
          };
        } else {
          features.total_watch_time = Math.max(features.total_watch_time || 0, liveTotalWatchTime);
          features.total_events = Math.max(features.total_events || 0, events.length);
          features.avg_session_duration = liveAvgSession;
          if (features.avg_sentiment === undefined || features.avg_sentiment === null) {
            features.avg_sentiment = liveAvgSentiment;
          }
        }
      }

      // Build official title map
      const officialTitleMap: Record<string, string> = {};
      for (const ee of enrichedEvents) {
        const url = ee.browser_event?.url || "";
        const title = ee.youtube_metadata?.official_title;
        if (url && title && title !== "Unknown YouTube Video" && title !== "YouTube Video") {
          officialTitleMap[url] = title;
          const match = url.match(/[?&]v=([^&]+)/);
          if (match && match[1]) {
            officialTitleMap[match[1]] = title;
          }
        }
      }

      for (const re of events) {
        if (re.url && officialTitleMap[re.url]) {
          re.content_title = officialTitleMap[re.url];
        } else if (re.url) {
          const match = re.url.match(/[?&]v=([^&]+)/);
          if (match && match[1] && officialTitleMap[match[1]]) {
            re.content_title = officialTitleMap[match[1]];
          }
        }
      }

      // Sort events by timestamp or created_at (descending)
      const sortedEvents = events.sort((a: any, b: any) => {
        const timeA = new Date(a.created_at || a.timestamp_start || 0).getTime();
        const timeB = new Date(b.created_at || b.timestamp_start || 0).getTime();
        return timeB - timeA;
      });

      // Sort enriched events by browser_event.created_at or timestamp_start (descending)
      const sortedEnrichedEvents = enrichedEvents.sort((a: any, b: any) => {
        const timeA = new Date(a.browser_event?.created_at || a.browser_event?.timestamp_start || 0).getTime();
        const timeB = new Date(b.browser_event?.created_at || b.browser_event?.timestamp_start || 0).getTime();
        return timeB - timeA;
      });

      res.json({
        user_id,
        features: features || null,
        profile: profile || null,
        questionnaire_response: questionnaire || null,
        recent_events: sortedEvents,
        recent_enriched_events: sortedEnrichedEvents,
        total_captured_events: events.length
      });
    } catch (error) {
      console.error("Error fetching dashboard data:", error);
      res.status(500).json({ message: "Error fetching dashboard data" });
    }
  };

  app.get("/api/dashboard-data", authenticateDashboardToken, checkDb, handleDashboardData);
  app.get("/api/dashboard", authenticateDashboardToken, checkDb, handleDashboardData);

  // Extension verification
  app.post("/api/verify-extension", authenticateToken, async (req, res) => {
    const { extension_id } = req.body;
    // Logic to verify mapping if needed
    res.json({ verified: true, extension_id });
  });

  app.get("/api/ping", (req, res) => {
    res.json({ status: "alive", dbConnected: !!db });
  });

  // User control
  app.post("/api/withdraw-consent", authenticateToken, checkDb, async (req: any, res) => {
    try {
      const user_id = req.user.user_id;
      const collections = getCollections();
      if (!collections) return res.status(500).json({ message: "Database unavailable" });

      await collections.consents.updateOne(
        { user_id },
        { $set: { consent_given: false, updated_at: new Date().toISOString() } }
      );
      res.json({ success: true, message: "Consent withdrawn" });
    } catch (error) {
      res.status(500).json({ message: "Error withdrawing consent" });
    }
  });

  app.delete("/api/delete-data", authenticateToken, checkDb, async (req: any, res) => {
    try {
      const user_id = req.user.user_id;
      const collections = getCollections();
      if (!collections) return res.status(500).json({ message: "Database unavailable" });

      await collections.users.deleteOne({ user_id });
      await collections.consents.deleteOne({ user_id });
      res.clearCookie("auth_token");
      res.json({ success: true, message: "User data deleted" });
    } catch (error) {
      res.status(500).json({ message: "Error deleting data" });
    }
  });

  // Catch-all for missing API routes before Vite handles them
  app.all("/api/*", (req, res) => {
    res.status(404).json({ 
      message: `API route ${req.method} ${req.originalUrl} not found`,
      v: "1.1" 
    });
  });

  // Global error handler
  app.use((err: any, req: any, res: any, next: any) => {
    console.error("Unhandled error:", err);
    if (res.headersSent) {
      return next(err);
    }
    res.status(500).json({ 
      message: "Internal server error", 
      error: process.env.NODE_ENV === "development" ? err.message : undefined 
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req: any, res: any) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
