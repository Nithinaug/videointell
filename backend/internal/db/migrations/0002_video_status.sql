ALTER TABLE videos ADD COLUMN IF NOT EXISTS results JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_original_key ON videos(original_key);

CREATE OR REPLACE FUNCTION set_video_status(p_key TEXT, p_from TEXT[], p_to TEXT, p_results JSONB DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE sql
AS $$
    WITH updated AS (
        UPDATE videos
        SET status = p_to, results = COALESCE(p_results, results), updated_at = now()
        WHERE original_key = p_key AND status = ANY(p_from)
        RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM updated);
$$;
