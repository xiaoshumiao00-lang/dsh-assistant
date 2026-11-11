#!/usr/bin/env python3
"""Capture the tihu firmware boot log from a serial port.

Resets the board through the standard DTR/RTS lines (EN=RTS, IO0=DTR), then
prints everything the firmware logs for N seconds and saves it to a file.

Usage: python tools/serial_capture.py --port COM3 --seconds 25 --out build/serial.log
"""
import argparse
import time

import serial


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', default='COM3')
    ap.add_argument('--baud', type=int, default=115200)
    ap.add_argument('--seconds', type=float, default=25.0)
    ap.add_argument('--out', default='')
    ap.add_argument('--no-reset', action='store_true')
    args = ap.parse_args()

    ser = serial.Serial(args.port, args.baud, timeout=0.2)
    if not args.no_reset:
        # EN low -> release: same sequence esptool uses for a hard reset.
        ser.dtr = False
        ser.rts = True
        time.sleep(0.15)
        ser.rts = False
        time.sleep(0.05)
    ser.reset_input_buffer()

    deadline = time.time() + args.seconds
    chunks = []
    while time.time() < deadline:
        data = ser.read(4096)
        if data:
            chunks.append(data)
            print(data.decode('utf-8', 'replace'), end='', flush=True)
    ser.close()

    if args.out:
        with open(args.out, 'wb') as fh:
            fh.write(b''.join(chunks))
        print('\n[saved %d bytes to %s]' % (sum(len(c) for c in chunks), args.out))


if __name__ == '__main__':
    main()
