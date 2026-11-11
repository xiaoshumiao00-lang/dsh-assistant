#!/usr/bin/env python3
"""串口实时落盘：一直读，边读边写文件（不缓冲、不复位）。

和 serial_capture.py 的区别：那个是「抓 N 秒再一次性写文件」，后台跑的时候中途看不到；
这个每读到一块就 flush，随时可以 tail 文件确认板子刚刚打印了什么。

用法:
  python tools/serial_tail.py --port COM3 --out build/serial-live.log
"""
import argparse
import time

import serial


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', default='COM3')
    ap.add_argument('--baud', type=int, default=115200)
    ap.add_argument('--out', default='build/serial-live.log')
    ap.add_argument('--seconds', type=float, default=0.0, help='0 表示一直读')
    args = ap.parse_args()

    # 端口常被别的进程（烧录/另一路监视）短时占用：这里一直重试，抢到就读，
    # 而不是像以前那样抛异常直接退出、把这次抓取白白丢掉。
    ser = None
    while ser is None:
        try:
            ser = serial.Serial(args.port, args.baud, timeout=0.2)
        except Exception as exc:  # SerialException / PermissionError
            print('waiting for %s: %s' % (args.port, exc), flush=True)
            time.sleep(2)
    print('opened %s' % args.port, flush=True)

    deadline = time.time() + args.seconds if args.seconds > 0 else None
    with open(args.out, 'ab', buffering=0) as fh:
        try:
            while deadline is None or time.time() < deadline:
                data = ser.read(4096)
                if data:
                    fh.write(data)
        except KeyboardInterrupt:
            pass
        finally:
            ser.close()


if __name__ == '__main__':
    main()
