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

// the engine and the camera readers run above normal (like OBS); each encoder as Live Studio asks (prio)
func setOwnPriority() {
	h, _, _ := procGetCurrentProc.Call()
	procSetPriorityClass.Call(h, aboveNormalPriorityClass)
	procTimeBeginPeriod.Call(1) // 1 ms timer resolution for the frame clock
}

// level: 1 above normal, 0 normal, -1 below normal
func procAttr(cmd *exec.Cmd, level int) {
	flags := uint32(createNoWindow)
	if level > 0 {
		flags |= aboveNormalPriorityClass
	} else if level < 0 {
		flags |= belowNormalPriorityClass
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: flags}
}
