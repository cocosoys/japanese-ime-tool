import math
from PIL import Image, ImageDraw

SS = 16 * 8  # 128x128 超采样，便于 16x16 抗锯齿
SIZE = 16

def make_flower(ss):
    img = Image.new('RGBA', (ss, ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = cy = ss / 2
    petal_color = (255, 182, 213, 255)   # 樱花粉 #FFB6D5
    petal_edge = (247, 140, 178, 255)    # 深粉描边 #F78CB2
    center_col = (255, 216, 61, 255)     # 花蕊黄 #FFD83D
    stamen_col = (230, 160, 40, 255)     # 花蕊小点
    # 5 片花瓣（五边形顶点，顶部为正）
    angles = [90, 162, 234, 306, 18]
    R = ss * 0.30        # 花瓣中心到花心距离
    pr = ss * 0.26       # 花瓣半径
    for a in angles:
        rad = math.radians(a)
        px = cx + R * math.cos(rad)
        py = cy - R * math.sin(rad)
        d.ellipse([px - pr, py - pr, px + pr, py + pr], fill=petal_edge)
    for a in angles:
        rad = math.radians(a)
        px = cx + R * math.cos(rad)
        py = cy - R * math.sin(rad)
        r2 = pr * 0.86
        d.ellipse([px - r2, py - r2, px + r2, py + r2], fill=petal_color)
    # 花心
    rc = ss * 0.14
    d.ellipse([cx - rc, cy - rc, cx + rc, cy + rc], fill=center_col)
    # 花蕊小点
    for da in range(0, 360, 60):
        rad = math.radians(da)
        sx = cx + rc * 0.55 * math.cos(rad)
        sy = cy + rc * 0.55 * math.sin(rad)
        d.ellipse([sx - ss * 0.02, sy - ss * 0.02, sx + ss * 0.02, sy + ss * 0.02], fill=stamen_col)
    return img

big = make_flower(SS)
icon16 = big.resize((SIZE, SIZE), Image.LANCZOS)
icon16.save('assets/icon.png')
print('wrote assets/icon.png', icon16.size)

sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
frames = [big.resize(s, Image.LANCZOS) for s in sizes]
frames[0].save('assets/icon.ico', sizes=[(s[0], s[1]) for s in sizes])
print('wrote assets/icon.ico with sizes', sizes)
