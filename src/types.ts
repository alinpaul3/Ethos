export interface UserProfile {
  user_id: string;
  email: string;
  created_at: string;
}

export interface ConsentRecord {
  user_id: string;
  consent_given: boolean;
  consent_timestamp: string;
}

export interface ExtensionConnection {
  user_id: string;
  extension_id: string;
  connected_at: string;
}
