package paper

import (
	"context"
	"testing"
	"time"
)

func TestTicksValidation(t *testing.T) {
	p := New()
	now := time.UnixMilli(1792013460000)
	for _, c := range [][2]string{{"x", "1792013400000"}, {"0", "1792013400001"}, {"0", "1792013520000"}, {"0", "1792011000000"}, {"99", "1792013400000"}} {
		if _, err := p.Ticks(context.Background(), c[0], c[1], now); err == nil {
			t.Errorf("accepted %v", c)
		}
	}
}
