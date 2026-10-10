export interface Env {
  ASSETS: Fetcher;
  AI: Ai;
  EMAIL: {
    send(message: EmailPayload): Promise<{ messageId: string }>;
  };
  DB: D1Database;
  KVEDGEFORM: KVNamespace;
  BUCKET: R2Bucket;
  FORM_GUARD: DurableObjectNamespace;
  MAILQ: Queue<MailJob>;
  APP_NAME: string;
  BRAND: string;
  FROM_EMAIL: string;
  FROM_NAME: string;
  PUBLIC_ORIGIN: string;
  SESSION_TTL_SECONDS: string;
  SESSION_JWT_SECRET?: string;
  SESSION_JWT_SECRET_PREV?: string;
  INTERNAL_PROVISION_SECRET?: string;
  ADMIN_EMAILS?: string;
}

export interface EmailPayload {
  to: string | { email: string; name?: string } | Array<string | { email: string; name?: string }>;
  from: string | { email: string; name?: string };
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string | { email: string; name?: string };
}

export interface MailJob {
  submissionId: string;
  formId: string;
}

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  password_hash: string;
  password_salt: string;
  created_at: number;
  verified_at: number | null;
  account_user_id?: string | null;
}

export interface FormRow {
  id: string;
  user_id: string;
  name: string;
  slug: string;
  destination_email: string;
  reply_to_field: string;
  allowed_origins: string | null;
  redirect_url: string | null;
  honeypot_field: string;
  notify_email: number;
  store_submissions: number;
  schema_json: string | null;
  embed_html: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface FieldSchema {
  name: string;
  label: string;
  type: string;
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: string[];
}

export interface FormTheme {
  font: string;
  background: string;
  text: string;
  muted: string;
  accent: string;
  fieldBackground: string;
  buttonText: string;
  buttonColor: string;
  buttonTextColor: string;
}

export interface FormSchema {
  name?: string;
  fields: FieldSchema[];
  theme?: FormTheme;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
