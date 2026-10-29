package mute

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

const createNoWindow = 0x08000000

// hiddenCmd обязателен для дочерних процессов из GUI-приложения:
// без CREATE_NO_WINDOW Windows показывает чёрное окно консоли.
func hiddenCmd(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	return cmd
}

// KillTree убивает процесс вместе с потомками. exec.CommandContext на
// Windows не убивает дочерние процессы (проверено в ClipNip), поэтому
// только taskkill /T /F.
func KillTree(pid int) {
	if pid <= 0 {
		return
	}
	cmd := hiddenCmd("taskkill", "/PID", strconv.Itoa(pid), "/T", "/F")
	_ = cmd.Run()
}

type limitedBuffer struct {
	mu    sync.Mutex
	buf   []byte
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.buf = append(b.buf, p...)
	if len(b.buf) > b.limit {
		b.buf = b.buf[len(b.buf)-b.limit:]
	}
	return len(p), nil
}

func (b *limitedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return strings.TrimSpace(string(b.buf))
}

// runCaptured запускает инструмент с таймаутом и убивает дерево процессов
// при отмене: таймер + taskkill, не CommandContext.
func runCaptured(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := hiddenCmd(name, args...)
	var stdout bytes.Buffer
	stderr := &limitedBuffer{limit: 4096}
	cmd.Stdout = &stdout
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			return stdout.Bytes(), fmt.Errorf("%v: %s", err, stderr.String())
		}
		return stdout.Bytes(), nil
	case <-ctx.Done():
		KillTree(cmd.Process.Pid)
		<-done
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, fmt.Errorf("таймаут: %s", stderr.String())
		}
		return nil, ctx.Err()
	}
}
