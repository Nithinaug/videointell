CREATE TABLE IF NOT EXISTS clips (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id   UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    title      TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
    start_ms   BIGINT NOT NULL CHECK (start_ms >= 0),
    end_ms     BIGINT NOT NULL CHECK (end_ms > start_ms AND end_ms - start_ms <= 300000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clips_video_id ON clips (video_id, start_ms);
