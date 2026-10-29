package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"mutenip/mute"
)

type app struct {
	tools mute.Tools
	cfg   config

	mu   sync.Mutex
	scan *scanState
	proc *processState
}

type scanState struct {
	running bool
	cancel  context.CancelFunc
	dir     string
	total   int
	done    int
	files   []mute.File
	err     string
}

type procFile struct {
	Path     string  `json:"path"`
	Rel      string  `json:"rel"`
	Duration float64 `json:"duration"`
	Size     int64   `json:"size"`
	Status   string  `json:"status"`
	Error    string  `json:"error"`
	Warning  string  `json:"warning"`
	Before   int64   `json:"before"`
	After    int64   `json:"after"`
	Saved    int64   `json:"saved"`
}

type processState struct {
	running      bool
	cancel       context.CancelFunc
	dir          string
	deleteSource bool
	files        []procFile
	done         int
	current      string
	curFraction  float64
	curSize      int64
	totalWeight  int64
	doneWeight   int64
	err          string
}

type scanStatus struct {
	Running bool        `json:"running"`
	Dir     string      `json:"dir"`
	Total   int         `json:"total"`
	Done    int         `json:"done"`
	Files   []mute.File `json:"files"`
	Error   string      `json:"error"`
}

type processStatus struct {
	Running         bool       `json:"running"`
	Dir             string     `json:"dir"`
	DeleteSource    bool       `json:"delete_source"`
	Total           int        `json:"total"`
	Done            int        `json:"done"`
	Current         string     `json:"current"`
	CurrentFraction float64    `json:"current_fraction"`
	Fraction        float64    `json:"fraction"`
	Files           []procFile `json:"files"`
	Error           string     `json:"error"`
}

func newApp(tools mute.Tools) *app {
	return &app{tools: tools, cfg: loadConfig()}
}

func (a *app) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/folder", a.handleFolder)
	mux.HandleFunc("/api/config", a.handleConfig)
	mux.HandleFunc("/api/tools", a.handleTools)
	mux.HandleFunc("/api/scan", a.handleScan)
	mux.HandleFunc("/api/scan/status", a.handleScanStatus)
	mux.HandleFunc("/api/scan/cancel", a.handleScanCancel)
	mux.HandleFunc("/api/process", a.handleProcess)
	mux.HandleFunc("/api/process/status", a.handleProcessStatus)
	mux.HandleFunc("/api/process/cancel", a.handleProcessCancel)
	mux.HandleFunc("/api/open", a.handleOpen)

	web, err := fs.Sub(webFiles, "web")
	if err != nil {
		panic(err)
	}
	mux.Handle("/", http.FileServer(http.FS(web)))
	return mux
}

func (a *app) handleFolder(w http.ResponseWriter, r *http.Request) {
	if !requirePOST(w, r) {
		return
	}
	path, err := browseFolder("Выберите папку с видео")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, map[string]string{"path": path})
}

func (a *app) handleConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]string{"last_dir": a.cfg.LastDir})
}

func (a *app) handleTools(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{
		"ready":   a.tools.Ready(),
		"ffmpeg":  a.tools.FFmpeg,
		"ffprobe": a.tools.FFprobe,
		"error":   a.tools.Problem(),
	})
}

func (a *app) handleScan(w http.ResponseWriter, r *http.Request) {
	if !requirePOST(w, r) {
		return
	}
	if !a.tools.Ready() {
		writeErr(w, http.StatusBadRequest, a.tools.Problem())
		return
	}
	var req struct {
		Dir string `json:"dir"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	dir, err := filepath.Abs(strings.TrimSpace(req.Dir))
	if err != nil || req.Dir == "" {
		writeErr(w, http.StatusBadRequest, "не указана папка")
		return
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		writeErr(w, http.StatusBadRequest, "папка не найдена: "+dir)
		return
	}
	if err := a.startScan(dir); err != nil {
		writeErr(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *app) startScan(dir string) error {
	a.mu.Lock()
	if a.scan != nil && a.scan.running {
		a.mu.Unlock()
		return errors.New("сканирование уже идёт")
	}
	if a.proc != nil && a.proc.running {
		a.mu.Unlock()
		return errors.New("идёт удаление звука")
	}
	ctx, cancel := context.WithCancel(context.Background())
	st := &scanState{running: true, cancel: cancel, dir: dir}
	a.scan = st
	a.mu.Unlock()

	a.cfg.LastDir = dir
	saveConfig(a.cfg)
	log.Printf("scan: %s", dir)
	go a.runScan(ctx, st)
	return nil
}

func (a *app) runScan(ctx context.Context, st *scanState) {
	files, err := mute.ListCandidates(st.dir)
	if err != nil {
		a.mu.Lock()
		st.running = false
		st.err = err.Error()
		a.mu.Unlock()
		st.cancel()
		return
	}

	index := make(map[string]int, len(files))
	for i, f := range files {
		index[f.Path] = i
	}
	a.mu.Lock()
	st.files = files
	st.total = len(files)
	a.mu.Unlock()

	for f := range mute.ProbeAll(ctx, a.tools, files, 6) {
		a.mu.Lock()
		if i, ok := index[f.Path]; ok {
			st.files[i] = f
		}
		st.done++
		a.mu.Unlock()
	}

	a.mu.Lock()
	st.running = false
	if st.done < st.total {
		st.err = "сканирование остановлено"
	}
	done, total := st.done, st.total
	a.mu.Unlock()
	st.cancel()
	log.Printf("scan done: %d of %d files", done, total)
}

func (a *app) handleScanStatus(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.scan == nil {
		writeJSON(w, scanStatus{})
		return
	}
	s := a.scan
	files := make([]mute.File, len(s.files))
	copy(files, s.files)
	writeJSON(w, scanStatus{
		Running: s.running,
		Dir:     s.dir,
		Total:   s.total,
		Done:    s.done,
		Files:   files,
		Error:   s.err,
	})
}

func (a *app) handleScanCancel(w http.ResponseWriter, r *http.Request) {
	if !requirePOST(w, r) {
		return
	}
	a.mu.Lock()
	if a.scan != nil && a.scan.running && a.scan.cancel != nil {
		a.scan.cancel()
	}
	a.mu.Unlock()
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *app) handleProcess(w http.ResponseWriter, r *http.Request) {
	if !requirePOST(w, r) {
		return
	}
	var req struct {
		Paths        []string `json:"paths"`
		DeleteSource bool     `json:"delete_source"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := a.startProcess(req.Paths, req.DeleteSource); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *app) startProcess(paths []string, deleteSource bool) error {
	a.mu.Lock()
	if a.proc != nil && a.proc.running {
		a.mu.Unlock()
		return errors.New("удаление уже идёт")
	}
	if a.scan == nil {
		a.mu.Unlock()
		return errors.New("сначала выберите папку")
	}
	if a.scan.running {
		a.mu.Unlock()
		return errors.New("дождитесь окончания сканирования")
	}

	index := make(map[string]mute.File, len(a.scan.files))
	for _, f := range a.scan.files {
		index[f.Path] = f
	}
	seen := make(map[string]bool, len(paths))
	var chosen []mute.File
	for _, p := range paths {
		if seen[p] {
			continue
		}
		seen[p] = true
		f, ok := index[p]
		if !ok {
			a.mu.Unlock()
			return fmt.Errorf("файл не из текущего скана: %s", p)
		}
		if !f.Probed || f.Err != "" || !f.HasVideo || !f.HasAudio {
			a.mu.Unlock()
			return fmt.Errorf("файл не подходит: %s", f.Rel)
		}
		chosen = append(chosen, f)
	}
	if len(chosen) == 0 {
		a.mu.Unlock()
		return errors.New("не выбрано ни одного файла")
	}

	st := &processState{
		running:      true,
		dir:          a.scan.dir,
		deleteSource: deleteSource,
	}
	for _, f := range chosen {
		st.files = append(st.files, procFile{
			Path:     f.Path,
			Rel:      f.Rel,
			Duration: f.Duration,
			Size:     f.Size,
			Status:   "queued",
		})
		st.totalWeight += f.Size
	}
	ctx, cancel := context.WithCancel(context.Background())
	st.cancel = cancel
	a.proc = st
	a.mu.Unlock()

	log.Printf("process: %d files, delete source: %v", len(chosen), deleteSource)
	go a.runProcess(ctx, st)
	return nil
}

func (a *app) runProcess(ctx context.Context, st *processState) {
	defer func() {
		a.mu.Lock()
		st.running = false
		st.current = ""
		done, total := st.done, len(st.files)
		a.mu.Unlock()
		st.cancel()
		log.Printf("process done: %d of %d", done, total)
	}()

	for i := range st.files {
		if ctx.Err() != nil {
			a.cancelFrom(i)
			return
		}
		pf := &st.files[i]
		a.mu.Lock()
		pf.Status = "running"
		st.current = pf.Rel
		st.curSize = pf.Size
		st.curFraction = 0
		a.mu.Unlock()
		log.Printf("process: %s", pf.Rel)

		res, err := mute.RemoveAudio(ctx, a.tools, pf.Path, pf.Duration,
			mute.Options{DeleteSource: st.deleteSource},
			mute.Hooks{OnProgress: func(p mute.Progress) {
				a.mu.Lock()
				st.curFraction = p.Fraction
				a.mu.Unlock()
			}},
		)

		a.mu.Lock()
		st.done++
		st.doneWeight += pf.Size
		st.curSize = 0
		st.curFraction = 0
		switch {
		case errors.Is(err, mute.ErrCancelled):
			pf.Status = "cancelled"
		case err != nil:
			pf.Status = "error"
			pf.Error = err.Error()
			log.Printf("process error: %s: %v", pf.Rel, err)
		default:
			pf.Status = "done"
			pf.Before, pf.After, pf.Saved = res.Before, res.After, res.Saved
			pf.Warning = res.Warning
			log.Printf("process ok: %s, saved %d bytes", pf.Rel, res.Saved)
		}
		a.mu.Unlock()

		if errors.Is(err, mute.ErrCancelled) {
			a.cancelFrom(i + 1)
			return
		}
	}
}

func (a *app) cancelFrom(from int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for i := from; i < len(a.proc.files); i++ {
		if a.proc.files[i].Status == "queued" {
			a.proc.files[i].Status = "cancelled"
		}
	}
}

func (a *app) handleProcessStatus(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.proc == nil {
		writeJSON(w, processStatus{})
		return
	}
	s := a.proc
	files := make([]procFile, len(s.files))
	copy(files, s.files)
	fraction := 0.0
	if s.totalWeight > 0 {
		fraction = (float64(s.doneWeight) + float64(s.curSize)*s.curFraction) / float64(s.totalWeight)
		if fraction > 1 {
			fraction = 1
		}
	}
	writeJSON(w, processStatus{
		Running:         s.running,
		Dir:             s.dir,
		DeleteSource:    s.deleteSource,
		Total:           len(s.files),
		Done:            s.done,
		Current:         s.current,
		CurrentFraction: s.curFraction,
		Fraction:        fraction,
		Files:           files,
		Error:           s.err,
	})
}

func (a *app) handleProcessCancel(w http.ResponseWriter, r *http.Request) {
	if !requirePOST(w, r) {
		return
	}
	a.mu.Lock()
	if a.proc != nil && a.proc.running && a.proc.cancel != nil {
		a.proc.cancel()
	}
	a.mu.Unlock()
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *app) handleOpen(w http.ResponseWriter, r *http.Request) {
	if !requirePOST(w, r) {
		return
	}
	var req struct {
		Path string `json:"path"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	a.mu.Lock()
	root := ""
	if a.scan != nil {
		root = a.scan.dir
	}
	a.mu.Unlock()
	if root == "" {
		writeErr(w, http.StatusBadRequest, "папка ещё не выбрана")
		return
	}

	path := root
	if req.Path != "" {
		abs, err := filepath.Abs(req.Path)
		if err != nil || !within(root, abs) {
			writeErr(w, http.StatusBadRequest, "путь вне выбранной папки")
			return
		}
		path = abs
	}
	if info, err := os.Stat(path); err == nil && !info.IsDir() {
		path = filepath.Dir(path)
	}
	if err := exec.Command("explorer.exe", path).Start(); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func within(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel))
}

func requirePOST(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "только POST")
		return false
	}
	return true
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		writeErr(w, http.StatusBadRequest, "некорректный JSON")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
