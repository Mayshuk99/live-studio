import subprocess, numpy as np
SR=48000
speech=np.fromfile("speech.f32",np.float32).astype(np.float64)
mask=np.load("speech_mask.npy")
def run(inp, fb, nr, rv, out="o.f32"):
    subprocess.run(["./dsp_test","open",inp,out,str(fb),str(nr),str(rv)],check=True,capture_output=True)
    return np.fromfile(out,np.float32).astype(np.float64)
def snr(y, ref):
    a=np.dot(y,ref)/np.dot(ref,ref); e=y-a*ref
    return 10*np.log10(np.dot(a*ref,a*ref)/np.dot(e,e))
def pw(x,m): return 10*np.log10(np.mean(x[m]**2)+1e-20)

x=np.fromfile("noisy.f32",np.float32).astype(np.float64)
nz=np.fromfile("noise_only.f32",np.float32).astype(np.float64)
print("DE-NOISE  (speech + hum + hiss, SNR 10 dB)")
print(" knob   SNR vs clean   noise in pauses   speech level change   noise-only file")
for nr in [0,0.25,0.5,0.75,1.0]:
    y=run("noisy.f32",0,nr,0)
    yn=run("noise_only.f32",0,nr,0)
    print(f" {int(nr*100):3d}%   {snr(y,speech):6.1f} dB      {pw(y,~mask)-pw(x,~mask):6.1f} dB          {pw(y,mask)-pw(x,mask):6.1f} dB            {pw(yn,slice(SR*3,None))-pw(nz,slice(SR*3,None)):6.1f} dB")

x=np.fromfile("reverb.f32",np.float32).astype(np.float64)
print("\nDE-REVERB (T60 = 1.0 s room)")
print(" knob   direct/reverb ratio   tail energy in pauses   speech level change")
for rv in [0,0.25,0.5,0.75,1.0]:
    y=run("reverb.f32",0,0,rv)
    print(f" {int(rv*100):3d}%   {snr(y,speech):6.1f} dB             {pw(y,~mask)-pw(x,~mask):6.1f} dB               {pw(y,mask)-pw(x,mask):6.1f} dB")
