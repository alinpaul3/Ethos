import { MongoClient, Db } from "mongodb";

let client: MongoClient | null = null;
let db: Db | null = null;

export function validateConnectionString(uri: string): { isValid: boolean; reason?: string } {
  try {
    if (!uri.startsWith("mongodb://") && !uri.startsWith("mongodb+srv://")) {
      return { isValid: false, reason: "Connection string must start with 'mongodb://' or 'mongodb+srv://'." };
    }

    const schemeEnd = uri.indexOf("://") + 3;
    const lastAt = uri.lastIndexOf("@");
    
    if (lastAt === -1 || lastAt < schemeEnd) {
      return { isValid: true }; 
    }

    const afterScheme = uri.substring(schemeEnd);
    const atCount = (afterScheme.match(/@/g) || []).length;
    if (atCount > 1) {
      return { 
        isValid: false, 
        reason: "Your MongoDB password contains an un-encoded '@' character. Please URL-encode your password (e.g., replace '@' with '%40') in your connection string." 
      };
    }

    const credentialsPart = uri.substring(schemeEnd, lastAt);
    const colonIndex = credentialsPart.indexOf(":");
    if (colonIndex !== -1) {
      const password = credentialsPart.substring(colonIndex + 1);
      const forbiddenChars = [
        { char: ":", encoded: "%3A" },
        { char: "/", encoded: "%2F" },
        { char: "?", encoded: "%3F" },
        { char: "#", encoded: "%23" },
        { char: "[", encoded: "%5B" },
        { char: "]", encoded: "%5D" },
        { char: "@", encoded: "%40" },
        { char: "+", encoded: "%2B" },
        { char: " ", encoded: "%20" },
        { char: "&", encoded: "%26" }
      ];
      for (const item of forbiddenChars) {
        if (password.includes(item.char)) {
          return {
            isValid: false,
            reason: `Your MongoDB password contains an un-encoded special character '${item.char}'. Please replace it with its URL-encoded equivalent '${item.encoded}' in your connection string in the Secrets panel.`
          };
        }
      }
    }
  } catch (e) {
    // Ignore validation errors, let the driver handle it
  }
  return { isValid: true };
}

export async function connectToDatabase(): Promise<Db> {
  if (db) return db;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI environment variable is not defined. Please set it in the Secrets panel.");
  }

  // Pre-validate connection string for common special character mistakes
  const validation = validateConnectionString(uri);
  if (!validation.isValid) {
    throw new Error(validation.reason);
  }

  if (!client) {
    client = new MongoClient(uri, {
      connectTimeoutMS: 10000,
      serverSelectionTimeoutMS: 10000,
    });
    await client.connect();
    console.log("Connected to MongoDB");
  }

  db = client.db();
  return db;
}

