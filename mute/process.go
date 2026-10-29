package mute

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var (
	ErrCancelled = errors.New("отменено")
	ErrExists    = errors.New("файл уже существует")
)

type Options struct {
	DeleteSource bool
}

type Progress struct {
	Fraction float64
	Seconds  float64
}

type Result struct {
	Output  string
	Before  int64
	After   int64
	Saved   int64
	Warning string
}

type Hooks struct {
	OnProgress func(Progress)
}

// RemoveAudio перепаковывает файл без аудиодорожек. Видео копируется
// бит-в-бит, перекодирования нет. В режиме DeleteSource исходник
// заменяется результатом только после успешной проверки ffprobe.
func RemoveAudio(ctx context.Context, tools Tools, path string, duration float64, opts Options, hooks Hooks) (Result, error) {
	if !tools.Ready() {
		return Result{}, errors.New(tools.Problem())
	}
	if ctx.Err() != nil {
		return Result{}, ErrCancelled
	}
	info, err := os.Stat(path)
	if err != nil {
		return Result{}, err
	}
	if info.IsDir() {
		return Result{}, fmt.Errorf("%s — это папка", path)
	}
	if !opts.DeleteSource {
		if _, err := os.Stat(NoAudioName(path)); err == nil {
			return Result{}, fmt.Errorf("%w: %s", ErrExists, filepath.Base(NoAudioName(path)))
		}
	}
	if free, err := freeSpace(filepath.Dir(path)); err == nil && free < uint64(info.Size())+16*1024*1024 {
		return Result{}, fmt.Errorf("недостаточно места на диске: нужно %s, свободно %s",
			FormatBytes(info.Size()), FormatBytes(int64(free)))
	}

	dir := filepath.Dir(path)
	ext := filepath.Ext(path)
	stem := strings.TrimSuffix(filepath.Base(path), ext)
	tmp, err := os.CreateTemp(dir, stem+".mutenip-*"+ext)
	if err != nil {
		return Result{}, err
	}
	tmpPath := tmp.Name()
	_ = tmp.Close()
	defer os.Remove(tmpPath)

	cmd := hiddenCmd(tools.FFmpeg, buildRemuxArgs(path, tmpPath)...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return Result{}, err
	}
	stderr := &limitedBuffer{limit: 8192}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return Result{}, err
	}

	killDone := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			KillTree(cmd.Process.Pid)
		case <-killDone:
		}
	}()

	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		us, ok := parseProgressLine(scanner.Text())
		if !ok {
			continue
		}
		p := Progress{Seconds: float64(us) / 1e6}
		if duration > 0 && p.Seconds >= 0 {
			p.Fraction = p.Seconds / duration
			if p.Fraction > 1 {
				p.Fraction = 1
			}
		}
		if hooks.OnProgress != nil {
			hooks.OnProgress(p)
		}
	}
	waitErr := cmd.Wait()
	close(killDone)

	if ctx.Err() != nil {
		return Result{}, ErrCancelled
	}
	if waitErr != nil {
		msg := stderr.String()
		if msg == "" {
			msg = waitErr.Error()
		}
		return Result{}, fmt.Errorf("ffmpeg: %s", msg)
	}

	verifyCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	probe, err := ProbeFile(verifyCtx, tools, tmpPath)
	cancel()
	if err != nil {
		return Result{}, fmt.Errorf("проверка результата: %w", err)
	}
	if !probe.HasVideo {
		return Result{}, errors.New("в результате нет видеопотока")
	}
	if probe.HasAudio {
		return Result{}, errors.New("в результате остался аудиопоток")
	}
	tmpInfo, err := os.Stat(tmpPath)
	if err != nil {
		return Result{}, err
	}
	if tmpInfo.Size() <= 0 {
		return Result{}, errors.New("результат пустой")
	}

	res := Result{
		Before: info.Size(),
		After:  tmpInfo.Size(),
		Saved:  info.Size() - tmpInfo.Size(),
	}

	if opts.DeleteSource {
		warning, err := replaceSource(tmpPath, path)
		if err != nil {
			return Result{}, err
		}
		res.Output = path
		res.Warning = warning
		return res, nil
	}

	dest := NoAudioName(path)
	if _, err := os.Stat(dest); err == nil {
		return Result{}, fmt.Errorf("%w: %s", ErrExists, filepath.Base(dest))
	}
	if err := os.Rename(tmpPath, dest); err != nil {
		return Result{}, err
	}
	res.Output = dest
	return res, nil
}

func buildRemuxArgs(src, dst string) []string {
	return []string{
		"-hide_banner",
		"-nostdin",
		"-y",
		"-i", src,
		"-map", "0",
		"-map", "-0:a",
		"-c", "copy",
		"-progress", "pipe:1",
		"-nostats",
		"-loglevel", "error",
		dst,
	}
}

func NoAudioName(path string) string {
	ext := filepath.Ext(path)
	return strings.TrimSuffix(path, ext) + "_na" + ext
}

// replaceSource ставит результат на место исходника без окна, в котором
// файла не существует, и без риска затереть единственную копию сбойным
// результатом: тот уже проверен ffprobe до этого шага.
func replaceSource(tmpPath, src string) (string, error) {
	ext := filepath.Ext(src)
	stem := strings.TrimSuffix(src, ext)
	oldPath := stem + ".mutenip-old-" + strconv.FormatInt(time.Now().UnixNano(), 36) + ext

	if err := os.Rename(src, oldPath); err != nil {
		return "", err
	}
	if err := os.Rename(tmpPath, src); err != nil {
		if restoreErr := os.Rename(oldPath, src); restoreErr != nil {
			return "", fmt.Errorf("не удалось заменить файл (%v) и вернуть исходник (%v)", err, restoreErr)
		}
		return "", fmt.Errorf("не удалось заменить файл: %w", err)
	}
	if err := os.Remove(oldPath); err != nil {
		return "исходник заменён, но старую копию удалить не удалось: " + oldPath + ": " + err.Error(), nil
	}
	return "", nil
}

// parseProgressLine читает строки ffmpeg -progress. Оба поля времени —
// микросекунды (историческая особенность ffmpeg: out_time_ms тоже µs).
func parseProgressLine(line string) (int64, bool) {
	for _, key := range []string{"out_time_us=", "out_time_ms="} {
		if v, found := strings.CutPrefix(line, key); found {
			us, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
			if err != nil {
				return 0, false
			}
			return us, true
		}
	}
	return 0, false
}

var (
	kernel32                = syscall.NewLazyDLL("kernel32.dll")
	procGetDiskFreeSpaceExW = kernel32.NewProc("GetDiskFreeSpaceExW")
)

func freeSpace(dir string) (uint64, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return 0, err
	}
	volume := filepath.VolumeName(abs)
	if volume == "" {
		return 0, errors.New("не удалось определить том")
	}
	root, err := syscall.UTF16PtrFromString(volume + `\`)
	if err != nil {
		return 0, err
	}
	var freeAvailable, total, totalFree uint64
	r, _, callErr := procGetDiskFreeSpaceExW.Call(
		uintptr(unsafe.Pointer(root)),
		uintptr(unsafe.Pointer(&freeAvailable)),
		uintptr(unsafe.Pointer(&total)),
		uintptr(unsafe.Pointer(&totalFree)),
	)
	if r == 0 {
		return 0, callErr
	}
	return freeAvailable, nil
}
