ALTER TABLE messages ADD COLUMN IF NOT EXISTS inference_id uuid REFERENCES inference_records(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS messages_one_assistant_per_inference ON messages(inference_id) WHERE inference_id IS NOT NULL AND role='assistant';
