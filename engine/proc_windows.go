//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

const (
	aboveNormalPriorityClass = 0x00008000
	belowNormalPriorityClass = 0x00004000
	createNoWindow           = 0x08000000
)

var (
	kernel32             = syscall.NewLazyDLL("kernel32.dll")
	procSetPriorityClass = kernel32.NewProc("SetPriorityClass")
	procGetCurrentProc   = kernel32.NewProc("GetCurrentProcess")
	winmm                = syscall.NewLazyDLL("winmm.dll")
	procTimeBeginPeriod  = winmm.NewProc("timeBeginPeriod")
)

// the engine and the camera readers run above normal (like OBS), the encoders below normal: the picture goes first
func setOwnPriority() {
	h, _, _ := procGetCurrentProc.Call()
	procSetPriorityClass.Call(h, aboveNormalPriorityClass)
	procTimeBeginPeriod.Call(1) // 1 ms timer resolution for the frame clock
}

func procAttr(cmd *exec.Cmd, high bool) {
	flags := uint32(createNoWindow)
	if high {
		flags |= aboveNormalPriorityClass
	} else {
		flags |= belowNormalPriorityClass
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: flags}
}
