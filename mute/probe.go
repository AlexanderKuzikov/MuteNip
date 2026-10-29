package mute

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

type Probe struct {
	HasVideo     bool
	HasAudio     bool
	Duration     float64
	AudioCodec   string
	AudioBitrate int64
	Format       string
}

type ffprobeJSON struct {
	Streams []struct {
		CodecName   string `json:"codec_name"`
		CodecType   string `json:"codec_type"`
		Duration    string `json:"duration"`
		BitRate     string `json:"bit_rate"`
		Disposition struct {
			AttachedPic int `json:"attached_pic"`
		} `json:"disposition"`
	} `json:"streams"`
	Format struct {
		FormatName string `json:"format_name"`
		Duration   string `json:"duration"`
	} `json:"format"`
}

func ProbeFile(ctx context.Context, tools Tools, path string) (Probe, error) {
	if tools.FFprobe == "" {
		return Probe{}, errors.New("ffprobe не найден")
	}
	out, err := runCaptured(ctx, tools.FFprobe,
		"-v", "error",
		"-print_format", "json",
		"-show_format",
		"-show_streams",
		path,
	)
	if err != nil {
		return Probe{}, err
	}

	var raw ffprobeJSON
	if err := json.Unmarshal(out, &raw); err != nil {
		return Probe{}, fmt.Errorf("ffprobe вернул не JSON: %w", err)
	}

	p := Probe{Format: raw.Format.FormatName}
	p.Duration = parseFloat(raw.Format.Duration)
	for _, s := range raw.Streams {
		switch s.CodecType {
		case "video":
			if s.Disposition.AttachedPic == 0 {
				p.HasVideo = true
			}
		case "audio":
			if !p.HasAudio {
				p.HasAudio = true
				p.AudioCodec = s.CodecName
				p.AudioBitrate = int64(parseFloat(s.BitRate))
			}
		}
		if d := parseFloat(s.Duration); d > p.Duration {
			p.Duration = d
		}
	}
	return p, nil
}

func parseFloat(s string) float64 {
	s = strings.TrimSpace(s)
	if s == "" || s == "N/A" {
		return 0
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || v < 0 {
		return 0
	}
	return v
}

var fallbackAudioBitrate = map[string]int64{
	"aac":       128000,
	"mp3":       192000,
	"opus":      96000,
	"vorbis":    128000,
	"ac3":       384000,
	"eac3":      384000,
	"dts":       768000,
	"flac":      900000,
	"alac":      900000,
	"pcm_s16le": 1536000,
	"pcm_s24le": 2304000,
}

// EstimateAudioBytes — грубая оценка размера дорожки: битрейт × длительность.
// Для VBR врёт, но цифра нужна как ориентир при выборе, а не как отчёт.
func EstimateAudioBytes(codec string, bitrate int64, duration float64) int64 {
	if bitrate <= 0 {
		bitrate = fallbackAudioBitrate[strings.ToLower(codec)]
	}
	if bitrate <= 0 {
		bitrate = 128000
	}
	if duration <= 0 {
		return 0
	}
	return int64(float64(bitrate) / 8 * duration)
}
