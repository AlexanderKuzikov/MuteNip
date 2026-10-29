package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

var (
	user32          = syscall.NewLazyDLL("user32.dll")
	procMsgBox      = user32.NewProc("MessageBoxW")
	kernel32        = syscall.NewLazyDLL("kernel32.dll")
	procCreateMutex = kernel32.NewProc("CreateMutexW")
)

const errorAlreadyExists = 183

var errAlreadyRunning = errors.New("another MuteNip instance is already running")

// singleInstance не даёт двум окнам обрабатывать одну папку: в режиме
// удаления исходников это уже не косметика, а гонка за файлы.
func singleInstance() (syscall.Handle, error) {
	name, err := syscall.UTF16PtrFromString("Local\\MuteNip.SingleInstance")
	if err != nil {
		return 0, err
	}
	handle, _, callErr := procCreateMutex.Call(0, 0, uintptr(unsafe.Pointer(name)))
	if handle == 0 {
		return 0, callErr
	}
	if errno, ok := callErr.(syscall.Errno); ok && errno == errorAlreadyExists {
		syscall.CloseHandle(syscall.Handle(handle))
		return 0, errAlreadyRunning
	}
	return syscall.Handle(handle), nil
}

func dataDir() string {
	if dir := os.Getenv("MUTENIP_DATA"); dir != "" {
		return dir
	}
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "MuteNip")
}

func setupLog() (*os.File, error) {
	if err := os.MkdirAll(dataDir(), 0o700); err != nil {
		return nil, err
	}
	return os.OpenFile(logFilePath(), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
}

func logFilePath() string {
	return filepath.Join(dataDir(), "mutenip.log")
}

func msgBox(title, text string) {
	titlePtr, _ := syscall.UTF16PtrFromString(title)
	textPtr, _ := syscall.UTF16PtrFromString(text)
	procMsgBox.Call(0,
		uintptr(unsafe.Pointer(textPtr)),
		uintptr(unsafe.Pointer(titlePtr)),
		0x30, // MB_ICONWARNING | MB_OK
	)
}

func fatalBox(err error) {
	msgBox("MuteNip — startup error", fmt.Sprintf(
		"MuteNip could not start:\n\n%v\n\nSee %s for details.", err, logFilePath()))
}

func webView2Installed() bool {
	paths := []string{
		`SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`,
		`SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`,
	}
	for _, p := range paths {
		for _, root := range []syscall.Handle{syscall.HKEY_LOCAL_MACHINE, syscall.HKEY_CURRENT_USER} {
			var k syscall.Handle
			if err := syscall.RegOpenKeyEx(root, syscall.StringToUTF16Ptr(p), 0, syscall.KEY_READ, &k); err != nil {
				continue
			}
			var buf [128]uint16
			size := uint32(len(buf))
			err := syscall.RegQueryValueEx(k, syscall.StringToUTF16Ptr("pv"), nil, nil,
				(*byte)(unsafe.Pointer(&buf[0])), &size)
			syscall.RegCloseKey(k)
			if err == nil && size > 0 {
				return true
			}
		}
	}
	return false
}

type config struct {
	LastDir string `json:"last_dir"`
}

func loadConfig() config {
	var cfg config
	path := filepath.Join(dataDir(), "config.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return cfg
	}
	_ = json.Unmarshal(data, &cfg)
	return cfg
}

func saveConfig(cfg config) {
	if err := os.MkdirAll(dataDir(), 0o700); err != nil {
		log.Printf("config: %v", err)
		return
	}
	data, err := json.Marshal(cfg)
	if err != nil {
		log.Printf("config: %v", err)
		return
	}
	if err := os.WriteFile(filepath.Join(dataDir(), "config.json"), data, 0o600); err != nil {
		log.Printf("config: %v", err)
	}
}
