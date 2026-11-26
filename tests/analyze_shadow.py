import subprocess, numpy as np
from scipy import signal
SR=48000
mask=np.load("speech_mask.npy")
WARM=3*SR
mask_all=mask
def ld(n): return np.fromfile(n,np.float32).astype(np.float64)
def shadow(mix, part, nr, rv):
    subprocess.run(["./dsp_test","shadow",mix,part,"sh.f32",str(nr),str(rv)],check=True)
    return ld("sh.f32")
def pw(x,m=None):
    x=x[WARM:]; m=None if m is None else m[WARM:]
    x=x if m is None else x[m]; return 10*np.log10(np.mean(x**2)+1e-20)
def lsd(a,b):
    _,_,A=signal.stft(a,SR,nperseg=1024); _,_,B=signal.stft(b,SR,nperseg=1024)
    A=20*np.log10(np.abs(A)+1e-6); B=20*np.log10(np.abs(B)+1e-6)
    act=A.max(axis=0)>A.max()-40
    return np.mean(np.sqrt(np.mean((A[:,act]-B[:,act])**2,axis=0)))

def table(title, mix, sig, intf, label, knob):
    s0, i0 = ld(sig), ld(intf)
    print(title)
    print(f" knob   {label}: in -> out   removed: total / in pauses   speech level   speech distortion(LSD)")
    for a in [0,0.25,0.5,0.75,1.0]:
        nr, rv = (a,0) if knob=="nr" else (0,a)
        s1, i1 = shadow(mix,sig,nr,rv), shadow(mix,intf,nr,rv)
        print(f" {int(a*100):3d}%   {pw(s0,mask)-pw(i0):5.1f} -> {pw(s1,mask)-pw(i1):5.1f} dB        {pw(i1)-pw(i0):6.1f} / {pw(i1,~mask)-pw(i0,~mask):6.1f} dB       {pw(s1,mask)-pw(s0,mask):5.1f} dB      {lsd(s0,s1):5.2f} dB")
table("DE-NOISE  (speech + hum + hiss)", "noisy.f32","speech.f32","noise_only.f32","SNR","nr")
table("\nDE-REVERB (T60 = 1.0 s)", "reverb.f32","speech.f32","tail_only.f32","DRR","rv")
