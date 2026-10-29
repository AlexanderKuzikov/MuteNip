package main

import (
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"

	"mutenip/mute"

	"github.com/webview/webview_go"
)

func main() {
	logFile, err := setupLog()
	if err == nil {
		log.SetOutput(logFile)
		defer logFile.Close()
	}
	log.Printf("=== mutenip start ===")

	instance, err := singleInstance()
	if err != nil {
		if errors.Is(err, errAlreadyRunning) {
			if !headless() {
				msgBox("MuteNip", "MuteNip уже запущен.\n\nЗакройте открытое окно.")
			}
			log.Printf("single instance: another instance already running, exiting")
			return
		}
		log.Printf("single instance check failed: %v", err)
	}
	_ = instance

	tools := mute.FindTools()
	if tools.Ready() {
		log.Printf("tools: ffmpeg=%s ffprobe=%s", tools.FFmpeg, tools.FFprobe)
	} else {
		log.Printf("tools: %s", tools.Problem())
	}

	if !headless() && !webView2Installed() {
		log.Printf("WebView2 Runtime not found")
		msgBox("MuteNip",
			"Требуется Microsoft Edge WebView2 Runtime.\n\n"+
				"Установите его (бесплатно, один раз) и запустите MuteNip снова:\n"+
				"https://developer.microsoft.com/microsoft-edge/webview2/")
		return
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Printf("listen failed: %v", err)
		fatalBox(err)
		return
	}
	if port := os.Getenv("MUTENIP_PORT"); port != "" {
		if p, _ := strconv.Atoi(port); p > 0 {
			listener.Close()
			listener, err = net.Listen("tcp", "127.0.0.1:"+port)
			if err != nil {
				log.Printf("listen %s failed: %v", port, err)
				fatalBox(err)
				return
			}
		}
	}

	srv := &http.Server{Handler: newApp(tools).routes()}
	go srv.Serve(listener)

	addr := listener.Addr().String()
	log.Printf("http://%s", addr)
	fmt.Println("mutenip: http://" + addr)

	if headless() {
		select {}
	}
	runWebView(addr)
}

func headless() bool {
	return os.Getenv("MUTENIP_HEADLESS") == "1"
}

func runWebView(addr string) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("webview panic: %v", r)
			fatalBox(fmt.Errorf("webview error: %v", r))
		}
	}()
	w := webview.New(false)
	defer w.Destroy()
	w.SetTitle("MuteNip — remove audio from video")
	w.SetSize(1120, 820, webview.HintNone)
	w.Navigate("http://" + addr + "/")
	w.Run()
}
