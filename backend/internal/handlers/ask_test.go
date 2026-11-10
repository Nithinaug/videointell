package handlers

import (
	"strings"
	"testing"

	"videointell/backend/internal/models"
	"videointell/backend/internal/worker"
)

func TestPickContextNeighboursAndCaps(t *testing.T) {
	segs := []worker.Segment{{FromMS: 0, Text: "hello"}, {FromMS: 1, Text: "the go server"}, {FromMS: 2, Text: "uses gin"}, {FromMS: 3, Text: "unrelated"}, {FromMS: 4, Text: "more"}}
	v := askVideo{video: models.Video{ID: "v1", Title: "T"}, items: mergeItems(segs, nil)}
	lines, truncated := pickContext([]askVideo{v}, "What is the server?", false)
	if truncated || len(lines) != 3 || lines[0].FromMS != 0 || lines[2].FromMS != 2 {
		t.Fatalf("lines = %+v truncated=%v", lines, truncated)
	}

	many := make([]worker.Segment, 100)
	for i := range many {
		many[i] = worker.Segment{FromMS: int64(i), Text: "server line"}
	}
	lines, truncated = pickContext([]askVideo{{video: v.video, items: mergeItems(many, nil)}}, "server", false)
	if !truncated || len(lines) != maxAskLines {
		t.Fatalf("cap: %d %v", len(lines), truncated)
	}
	lines, truncated = pickContext([]askVideo{{video: v.video, items: mergeItems(many, nil)}}, "anything", true)
	if truncated || len(lines) != 100 {
		t.Fatalf("whole: %d %v", len(lines), truncated)
	}
	big := []worker.Segment{{Text: strings.Repeat("x", maxAskChars)}, {Text: "server x"}}
	if lines, truncated = pickContext([]askVideo{{video: v.video, items: mergeItems(big, nil)}}, "server", false); !truncated {
		t.Fatalf("char cap not hit: %d", len(lines))
	}
}

func TestParseAnswer(t *testing.T) {
	cases := []struct {
		in     string
		answer string
		idx    []int
	}{
		{`{"answer":"Gin","sources":[2]}`, "Gin", []int{1}},
		{"```json\n{\"answer\":\"Gin\",\"sources\":[2,2,9,0]}\n```", "Gin", []int{1}},
		{`{"answer":"Gin","sources":[]}`, "", nil},
		{`{"answer":"","sources":[1]}`, "", nil},
		{`not json`, "", nil},
	}
	for _, c := range cases {
		a, idx := parseAnswer(c.in, 3)
		if a != c.answer || len(idx) != len(c.idx) || (len(idx) > 0 && idx[0] != c.idx[0]) {
			t.Errorf("parseAnswer(%q) = %q %v", c.in, a, idx)
		}
	}
}

func TestMergeItemsOrdersSpeechAndScreen(t *testing.T) {
	items := mergeItems([]worker.Segment{{FromMS: 5000, Text: "spoken"}}, []worker.ScreenText{{FromMS: 0, Text: "title card"}, {FromMS: 9000, Text: "later"}})
	if len(items) != 3 || items[0].Kind != "screen" || items[1].Kind != "speech" || items[2].FromMS != 9000 {
		t.Fatalf("items = %+v", items)
	}
}

func TestLongVideoFallsBackToMatchingLines(t *testing.T) {
	items := make([]askItem, 0, 1000)
	for i := 0; i < 1000; i++ {
		items = append(items, askItem{FromMS: int64(i), Text: strings.Repeat("filler ", 10), Kind: "speech"})
	}
	items[500].Text = "the deploy failed on port 5432"
	if itemChars(items) <= maxVideoAskChars {
		t.Fatalf("test transcript too short: %d", itemChars(items))
	}
	lines, _ := pickContext([]askVideo{{video: models.Video{ID: "v"}, items: items}}, "why did the deploy fail", false)
	if len(lines) != 3 || lines[1].Text != "the deploy failed on port 5432" {
		t.Fatalf("lines = %d %+v", len(lines), lines)
	}
}
