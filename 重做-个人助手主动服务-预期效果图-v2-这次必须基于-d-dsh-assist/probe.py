from collections import Counter
from PIL import Image

BASE = r'D:\dsh-assistant\重做-个人助手主动服务-预期效果图-v2-这次必须基于-d-dsh-assist'

def palette(path, box, label, k=8):
    im = Image.open(path).convert('RGB')
    print(label, 'image', im.size, 'crop', box)
    c = im.crop(box)
    cnt = Counter()
    for px in c.getdata():
        r, g, b = px
        if abs(r - g) < 12 and abs(g - b) < 12 and abs(r - b) < 12:   # skip grayscale
            continue
        cnt[(r // 8 * 8, g // 8 * 8, b // 8 * 8)] += 1
    for col, n in cnt.most_common(k):
        print(f'   #{col[0]:02x}{col[1]:02x}{col[2]:02x} x{n}')

# mobile 780x1688 (2x scale of 390x844)
probe = 'ref-pocket-chat.png'
palette(probe, (10, 1500, 770, 1620), 'MOBILE composer bottom row')
palette(probe, (0, 100, 770, 200), 'MOBILE tabs/header')
probe2 = 'ref-web-chat.png'
print('--- desktop ---')
im2 = Image.open(probe2); print('web-chat size', im2.size)
