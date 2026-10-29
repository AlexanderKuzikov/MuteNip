package mute

import (
	"strings"
	"testing"
)

func TestIsVideoPath(t *testing.T) {
	yes := []string{"movie.mp4", "MOVIE.MKV", "clip.mov", "a.b.webm", "x.m4v", "y.ts", "z.wmv"}
	no := []string{"song.mp3", "file.flv", "readme.txt", "video", "archive.zip"}
	for _, name := range yes {
		if !IsVideoPath(name) {
			t.Errorf("%s должен считаться видео", name)
		}
	}
	for _, name := range no {
		if IsVideoPath(name) {
			t.Errorf("%s не должен считаться видео", name)
		}
	}
}

func TestEstimateAudioBytes(t *testing.T) {
	cases := []struct {
		codec    string
		bitrate  int64
		duration float64
		want     int64
	}{
		{"aac", 128000, 60, 960000},
		{"mp3", 0, 10, 240000},
		{"unknown", 0, 10, 160000},
		{"aac", 128000, 0, 0},
	}
	for _, c := range cases {
		if got := EstimateAudioBytes(c.codec, c.bitrate, c.duration); got != c.want {
			t.Errorf("EstimateAudioBytes(%q, %d, %v) = %d, want %d", c.codec, c.bitrate, c.duration, got, c.want)
		}
	}
}

func TestNoAudioName(t *testing.T) {
	cases := map[string]string{
		`C:\video\movie.mp4`:    `C:\video\movie_na.mp4`,
		`C:\video\movie.MKV`:    `C:\video\movie_na.MKV`,
		`C:\video\movie.tar.gz`: `C:\video\movie.tar_na.gz`,
	}
	for in, want := range cases {
		if got := NoAudioName(in); got != want {
			t.Errorf("NoAudioName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestBuildRemuxArgs(t *testing.T) {
	args := buildRemuxArgs("in.mp4", "out.mp4")
	joined := strings.Join(args, " ")
	for _, want := range []string{"-map 0", "-map -0:a", "-c copy", "-nostdin", "-progress pipe:1"} {
		if !strings.Contains(joined, want) {
			t.Errorf("в аргументах нет %q: %s", want, joined)
		}
	}
	if args[len(args)-1] != "out.mp4" {
		t.Errorf("последним аргументом должен быть выходной файл, получено %q", args[len(args)-1])
	}
}

func TestParseProgressLine(t *testing.T) {
	cases := []struct {
		line string
		want int64
		ok   bool
	}{
		{"out_time_us=5000000", 5000000, true},
		{"out_time_ms=2500000", 2500000, true},
		{"out_time=00:00:01.500000", 0, false},
		{"progress=continue", 0, false},
		{"out_time_us=N/A", 0, false},
	}
	for _, c := range cases {
		got, ok := parseProgressLine(c.line)
		if got != c.want || ok != c.ok {
			t.Errorf("parseProgressLine(%q) = (%d, %v), want (%d, %v)", c.line, got, ok, c.want, c.ok)
		}
	}
}

func TestFormatBytes(t *testing.T) {
	cases := map[int64]string{
		0:                      "0 B",
		999:                    "999 B",
		1024:                   "1 KB",
		1024 * 1024:            "1.0 MB",
		3 * 1024 * 1024 * 1024: "3.0 GB",
	}
	for in, want := range cases {
		if got := FormatBytes(in); got != want {
			t.Errorf("FormatBytes(%d) = %q, want %q", in, got, want)
		}
	}
}
