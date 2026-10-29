package mute

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

var videoExts = map[string]bool{
	".mp4":  true,
	".m4v":  true,
	".mov":  true,
	".mkv":  true,
	".webm": true,
	".avi":  true,
	".ts":   true,
	".mpg":  true,
	".mpeg": true,
	".wmv":  true,
}

func IsVideoPath(path string) bool {
	return videoExts[strings.ToLower(filepath.Ext(path))]
}

type File struct {
	Path         string  `json:"path"`
	Rel          string  `json:"rel"`
	Size         int64   `json:"size"`
	Duration     float64 `json:"duration"`
	HasVideo     bool    `json:"has_video"`
	HasAudio     bool    `json:"has_audio"`
	AudioCodec   string  `json:"audio_codec"`
	AudioBitrate int64   `json:"audio_bitrate"`
	EstSavings   int64   `json:"est_savings"`
	Probed       bool    `json:"probed"`
	Err          string  `json:"error"`
}

// ListCandidates обходит папку рекурсивно и возвращает видеофайлы
// из белого списка. Символические ссылки и junction-ы не разворачиваются:
// иначе циклы, а удаление исходника по ссылке ударило бы не туда.
func ListCandidates(root string) ([]File, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(root)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, &os.PathError{Op: "scan", Path: root, Err: os.ErrInvalid}
	}

	var files []File
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if path != root && skipDir(d.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		name := d.Name()
		if strings.Contains(name, ".mutenip-") {
			return nil
		}
		if !IsVideoPath(name) {
			return nil
		}
		fi, err := d.Info()
		if err != nil {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			rel = name
		}
		files = append(files, File{
			Path: path,
			Rel:  filepath.ToSlash(rel),
			Size: fi.Size(),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(files, func(i, j int) bool {
		return strings.ToLower(files[i].Rel) < strings.ToLower(files[j].Rel)
	})
	return files, nil
}

func skipDir(name string) bool {
	lower := strings.ToLower(name)
	return lower == "$recycle.bin" ||
		lower == "system volume information" ||
		lower == ".git" ||
		strings.HasPrefix(name, ".")
}

// ProbeAll пробит файлы пулом процессов. Возвращает канал готовых
// результатов: скан не держит всё в памяти до конца, а показывает
// список по мере поступления.
func ProbeAll(ctx context.Context, tools Tools, files []File, workers int) <-chan File {
	out := make(chan File)
	if len(files) == 0 {
		close(out)
		return out
	}
	if workers <= 0 {
		workers = 6
	}
	if workers > len(files) {
		workers = len(files)
	}

	jobs := make(chan File)
	var wg sync.WaitGroup
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func() {
			defer wg.Done()
			for f := range jobs {
				probeCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
				p, err := ProbeFile(probeCtx, tools, f.Path)
				cancel()
				f.Probed = true
				if err != nil {
					f.Err = err.Error()
				} else {
					f.HasVideo = p.HasVideo
					f.HasAudio = p.HasAudio
					f.Duration = p.Duration
					f.AudioCodec = p.AudioCodec
					f.AudioBitrate = p.AudioBitrate
					if p.HasAudio {
						f.EstSavings = EstimateAudioBytes(p.AudioCodec, p.AudioBitrate, p.Duration)
					}
				}
				select {
				case out <- f:
				case <-ctx.Done():
					return
				}
			}
		}()
	}
	go func() {
		defer close(jobs)
		for _, f := range files {
			select {
			case jobs <- f:
			case <-ctx.Done():
				return
			}
		}
	}()
	go func() {
		wg.Wait()
		close(out)
	}()
	return out
}
