package paper

import "testing"

func TestProxyPool(t *testing.T) {
	p, err := newProxyPool(" http://u:p@1.2.3.4:8080 , 5.6.7.8:3128, 9.9.9.9:1080:alice:s3cret ,socks5://h:1")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"http://u:p@1.2.3.4:8080", "http://5.6.7.8:3128", "http://alice:s3cret@9.9.9.9:1080", "socks5://h:1"}
	for i, w := range want {
		if p.urls[i].String() != w {
			t.Errorf("%d: %s, want %s", i, p.urls[i], w)
		}
	}
	var got []string
	for range 5 {
		u, _ := p.pick(nil)
		got = append(got, u.Host)
	}
	if got[0] != "1.2.3.4:8080" || got[1] != "5.6.7.8:3128" || got[4] != "1.2.3.4:8080" {
		t.Errorf("round robin %v", got)
	}
	if s := p.String(); s != "4 proxies (1.2.3.4:8080, 5.6.7.8:3128, 9.9.9.9:1080, h:1)" {
		t.Errorf("String() leaks or misprints: %s", s)
	}
	if e, _ := newProxyPool(""); e.String() != "direct" {
		t.Error("empty pool is not direct")
	}
	if _, err := newProxyPool("nonsense"); err == nil {
		t.Error("accepted a malformed proxy")
	}
}
