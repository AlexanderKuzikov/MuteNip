package mute

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// Tools — внешние бинарники. В exe они не вшиваются: PE внутри PE даёт
// ложные срабатывания антивирусов (ADR ClipNip 011/012). Ищутся рядом
// с exe, в кэше ClipNip и в PATH.
type Tools struct {
	FFmpeg  string
	FFprobe string
}

func (t Tools) Ready() bool {
	return t.FFmpeg != "" && t.FFprobe != ""
}

func (t Tools) Problem() string {
	switch {
	case t.FFmpeg == "" && t.FFprobe == "":
		return "не найдены ffmpeg.exe и ffprobe.exe — положите их рядом с mutenip.exe"
	case t.FFmpeg == "":
		return "не найден ffmpeg.exe — положите его рядом с mutenip.exe"
	case t.FFprobe == "":
		return "не найден ffprobe.exe — положите его рядом с mutenip.exe"
	}
	return ""
}

func FindTools() Tools {
	exeDir := ""
	if exe, err := os.Executable(); err == nil {
		exeDir = filepath.Dir(exe)
	}
	return Tools{
		FFmpeg:  findTool(exeDir, "ffmpeg"),
		FFprobe: findTool(exeDir, "ffprobe"),
	}
}

func findTool(exeDir, name string) string {
	var candidates []string
	if exeDir != "" {
		candidates = append(candidates, filepath.Join(exeDir, name+".exe"))
	}
	if local := os.Getenv("LOCALAPPDATA"); local != "" {
		candidates = append(candidates, filepath.Join(local, "clipnip", "bin", name+".exe"))
	}
	for _, path := range candidates {
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			return path
		}
	}
	if path, err := exec.LookPath(name + ".exe"); err == nil {
		return path
	}
	if path, err := exec.LookPath(name); err == nil {
		return path
	}
	return ""
}

func FormatBytes(n int64) string {
	const (
		kb = int64(1024)
		mb = kb * 1024
		gb = mb * 1024
	)
	switch {
	case n >= gb:
		return fmt.Sprintf("%.1f GB", float64(n)/float64(gb))
	case n >= mb:
		return fmt.Sprintf("%.1f MB", float64(n)/float64(mb))
	case n >= kb:
		return fmt.Sprintf("%.0f KB", float64(n)/float64(kb))
	default:
		return fmt.Sprintf("%d B", n)
	}
}
