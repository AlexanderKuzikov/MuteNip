package main

import (
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"unsafe"
)

var (
	procGetLogicalDrives = kernel32.NewProc("GetLogicalDrives")
	procGetDriveTypeW    = kernel32.NewProc("GetDriveTypeW")
)

type fsEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// handleFSDrives отдаёт список локальных дисков для постоянной панели
// навигации. Сетевые и отсоединённые тома отсекаются по типу.
func (a *app) handleFSDrives(w http.ResponseWriter, r *http.Request) {
	mask, _, _ := procGetLogicalDrives.Call()
	drives := make([]fsEntry, 0, 8)
	for i := 0; i < 26; i++ {
		if mask&(1<<uint(i)) == 0 {
			continue
		}
		letter := string(rune('A' + i))
		root := letter + `:\`
		ptr, err := syscall.UTF16PtrFromString(root)
		if err != nil {
			continue
		}
		typ, _, _ := procGetDriveTypeW.Call(uintptr(unsafe.Pointer(ptr)))
		switch typ {
		case 2, 3, 5, 6: // removable, fixed, cdrom, ramdisk
		default: // сетевые (4), неизвестные и отсоединённые адреса не нужны
			continue
		}
		drives = append(drives, fsEntry{Name: letter + ":", Path: root})
	}
	writeJSON(w, map[string]any{"drives": drives})
}

func (a *app) handleFSList(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("path")
	if raw == "" || !filepath.IsAbs(raw) {
		writeErr(w, http.StatusBadRequest, "нужен абсолютный путь")
		return
	}
	path := filepath.Clean(raw)
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		writeErr(w, http.StatusBadRequest, "папка не найдена")
		return
	}

	resp := struct {
		Path  string    `json:"path"`
		Dirs  []fsEntry `json:"dirs"`
		Error string    `json:"error"`
	}{Path: path, Dirs: []fsEntry{}}

	entries, err := os.ReadDir(path)
	if err != nil {
		log.Printf("fs list %s: %v", path, err)
		resp.Error = "нет доступа"
		writeJSON(w, resp)
		return
	}
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") || skipSystemDir(name) {
			continue
		}
		full := filepath.Join(path, name)
		isDir := e.IsDir()
		if !isDir && e.Type()&fs.ModeSymlink != 0 {
			if st, err := os.Stat(full); err == nil && st.IsDir() {
				isDir = true
			}
		}
		if !isDir {
			continue
		}
		resp.Dirs = append(resp.Dirs, fsEntry{Name: name, Path: full})
	}
	sort.Slice(resp.Dirs, func(i, j int) bool {
		return strings.ToLower(resp.Dirs[i].Name) < strings.ToLower(resp.Dirs[j].Name)
	})
	writeJSON(w, resp)
}

func skipSystemDir(name string) bool {
	lower := strings.ToLower(name)
	return lower == "$recycle.bin" || lower == "system volume information"
}
