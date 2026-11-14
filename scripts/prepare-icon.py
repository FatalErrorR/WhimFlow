"""Turn the icon artwork (build/icon-artwork.webp: the icon on a flat background, light
or dark) into build/icon.png, the app icon for macOS, Windows and Linux:

  * the background goes transparent; a clean soft shadow is drawn under the icon
  * the rounded square is scaled to Apple's icon grid: 824 of 1024 px, centred

The outline is measured, not keyed: rays cast from the middle of the icon find, coming
in from outside, the first sharp colour change (the soft shadow changes only gradually),
which is the icon's edge all the way round. Those edge points are smoothed and drawn as
an antialiased shape; pixels at the very edge take their colour from just inside, so no
cream from the old background shows on a dark Dock.

Run: python3 scripts/prepare-icon.py   (needs Pillow and numpy)
"""
import math
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC, OUT = ROOT / 'build/icon-artwork.webp', ROOT / 'build/icon.png'
OUT_IOS = ROOT / 'build/icon-ios.png'   # iOS: an opaque square; iOS rounds the corners itself
IOS_SLOT = ROOT / 'mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'
GRID, SIZE = 824, 1024          # Apple: an 824 px body on a 1024 px canvas
RAYS, SS = 1440, 4              # edge samples round the icon; supersampling for the outline
EDGE_STEP = 22.0                # colour change per pixel that counts as an edge (the shadow stays far below)
RIM_DROP, RIM_RISE = 10.0, 9.0  # or: darkened by this much towards the icon, then brighter by this much again

src = Image.open(SRC).convert('RGB')
img = np.asarray(src).astype(np.float32)
h, w, _ = img.shape
sm = np.asarray(src.filter(ImageFilter.GaussianBlur(1.2))).astype(np.float32)
border = np.concatenate([img[:6].reshape(-1, 3), img[-6:].reshape(-1, 3), img[:, :6].reshape(-1, 3), img[:, -6:].reshape(-1, 3)])
bg = np.median(border, axis=0)
DARK = float(bg @ np.array([0.299, 0.587, 0.114])) < 40
# On a dark background no shadow shows, so the edge is simply where the picture stops being
# background. On a light one the soft shadow must be passed over (sharp edge / dark rim below).
BG_DIFF = 14.0

lum = lambda c: float(c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114)
def sample(x, y):  # bilinear
    x0, y0 = int(math.floor(x)), int(math.floor(y))
    fx, fy = x - x0, y - y0
    x0, y0 = min(max(x0, 0), w - 2), min(max(y0, 0), h - 2)
    a, b, c, d = sm[y0, x0], sm[y0, x0 + 1], sm[y0 + 1, x0], sm[y0 + 1, x0 + 1]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy

# --- the outline: for each direction, the outermost sharp edge
cx, cy = w / 2, h / 2
radii = np.zeros(RAYS)
for i in range(RAYS):
    t = 2 * math.pi * i / RAYS
    dx, dy = math.cos(t), math.sin(t)
    r_max = min(abs((w - 2 - cx) / dx) if dx else 1e9, abs((h - 2 - cy) / dy) if dy else 1e9, 560)
    r, prev = r_max, sample(cx + r_max * dx, cy + r_max * dy)
    found = None
    low, low_at, start = lum(prev), r_max, lum(prev)
    while r > 250:
        r -= 0.5
        cur = sample(cx + r * dx, cy + r * dy)
        if DARK:
            if np.abs(cur - bg).sum() > BG_DIFF:
                found = r + 0.25
                break
            prev = cur
            continue
        if np.abs(cur - prev).sum() * 2 > EDGE_STEP:  # a sharp change (per pixel; steps are half a pixel)
            found = r + 0.25
            break
        # or: the shadow got darker all the way to the icon's rim, and inside it is brighter again
        L = lum(cur)
        if L < low: low, low_at = L, r
        elif start - low > RIM_DROP and L > low + RIM_RISE:
            found = low_at
            break
        prev = cur
    radii[i] = found if found is not None else np.nan
# fill any misses, then smooth round the circle (median against stray inner edges, then a mean)
idx = np.arange(RAYS)
ok = ~np.isnan(radii)
radii = np.interp(idx, idx[ok], radii[ok], period=RAYS)
def circ(a, k, fn):
    pad = np.concatenate([a[-k:], a, a[:k]])
    return np.array([fn(pad[j:j + 2 * k + 1]) for j in range(len(a))])
radii = circ(radii, 6, np.median)
# a rounded square has no dents: keep the outline convex (a stray inner edge cannot bite into it)
pts = [(cx + r * math.cos(2 * math.pi * i / RAYS), cy + r * math.sin(2 * math.pi * i / RAYS)) for i, r in enumerate(radii)]
def hull(points):
    points = sorted(set(points))
    def half(ps):
        out = []
        for p in ps:
            while len(out) >= 2 and (out[-1][0] - out[-2][0]) * (p[1] - out[-2][1]) - (out[-1][1] - out[-2][1]) * (p[0] - out[-2][0]) <= 0: out.pop()
            out.append(p)
        return out
    return half(points)[:-1] + half(points[::-1])[:-1]
hp = hull(pts)
# back to one radius per ray: where each ray leaves the convex outline
def leave(t):
    dx, dy = math.cos(t), math.sin(t)
    best = 0
    for (x1, y1), (x2, y2) in zip(hp, hp[1:] + hp[:1]):
        ex, ey = x2 - x1, y2 - y1
        den = dx * ey - dy * ex
        if abs(den) < 1e-9: continue
        s_ = ((x1 - cx) * ey - (y1 - cy) * ex) / den
        u = ((x1 - cx) * dy - (y1 - cy) * dx) / den
        if s_ > 0 and -1e-9 <= u <= 1 + 1e-9: best = max(best, s_)
    return best
radii = np.array([leave(2 * math.pi * i / RAYS) for i in range(RAYS)])
radii = circ(radii, 3, np.mean) - 0.8   # smooth, and a hair inside so no background shows

# --- the shape, antialiased
poly = [((cx + r * math.cos(2 * math.pi * i / RAYS)) * SS, (cy + r * math.sin(2 * math.pi * i / RAYS)) * SS) for i, r in enumerate(radii)]
mask = Image.new('L', (w * SS, h * SS), 0)
ImageDraw.Draw(mask).polygon(poly, fill=255)
mask = mask.resize((w, h), Image.LANCZOS)
alpha = np.asarray(mask).astype(np.float32) / 255

# --- edge colours from just inside
inner = np.asarray(mask.filter(ImageFilter.MinFilter(7))).astype(np.float32) / 255
def blur(arr, r):  # per channel, values 0-255
    return np.stack([np.asarray(Image.fromarray(np.clip(arr[..., i], 0, 255).round().astype(np.uint8), 'L').filter(ImageFilter.GaussianBlur(r))).astype(np.float32) for i in range(arr.shape[2])], axis=2)
known = (inner > 0.99).astype(np.float32)[..., None]
spread = blur(img * known, 3) / np.maximum(blur(np.repeat(known, 3, axis=2) * 255, 3) / 255, 1e-3)
colour = img.copy()
if not DARK:  # a light background would leave a pale fringe; a dark one leaves nothing visible (and keeps any rim)
    edge = (alpha > 0) & (known[..., 0] == 0)
    colour[edge] = spread[edge]

# --- a soft shadow from the outline
sh = Image.fromarray(np.roll((alpha * 255).astype(np.uint8), 10, axis=0)).filter(ImageFilter.GaussianBlur(14))
shadow_a = np.asarray(sh).astype(np.float32) / 255 * 0.28

out_a = alpha + shadow_a * (1 - alpha)
rgba = np.zeros((h, w, 4), np.float32)
rgba[..., :3] = colour * (alpha / np.maximum(out_a, 1e-4))[..., None]
rgba[..., 3] = out_a * 255
art = Image.fromarray(np.clip(rgba, 0, 255).round().astype(np.uint8), 'RGBA')

# --- onto Apple's grid: the body's width becomes 824, centred
xs = cx + radii * np.cos(2 * np.pi * idx / RAYS)
ys = cy + radii * np.sin(2 * np.pi * idx / RAYS)
left, right, top, bottom = xs.min(), xs.max(), ys.min(), ys.max()
scale = GRID / (right - left)
art = art.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
canvas = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
ox = round(SIZE / 2 - (left + right) / 2 * scale)
oy = round(SIZE / 2 - (top + bottom) / 2 * scale)
canvas.alpha_composite(art, dest=(max(0, ox), max(0, oy)), source=(max(0, -ox), max(0, -oy)))
canvas.save(OUT)

# --- iOS: the body only, full bleed, no transparency. Cropped a little inside the outline,
# so the corners iOS cuts never show a sliver of the artwork's own edge or rim.
inset = 0.035 * (right - left)
box = (left + inset, top + inset, right - inset, bottom - inset)
side = min(box[2] - box[0], box[3] - box[1])
cxb, cyb = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
box = (cxb - side / 2, cyb - side / 2, cxb + side / 2, cyb + side / 2)
fill = np.median(colour[int(cyb) - 40:int(cyb) + 40, int(left + inset):int(left + inset) + 6].reshape(-1, 3), axis=0)  # the body's own colour at its edge
flat = colour * alpha[..., None] + fill * (1 - alpha[..., None])
ios = Image.fromarray(np.clip(flat, 0, 255).round().astype(np.uint8), 'RGB').crop(tuple(round(v) for v in box)).resize((1024, 1024), Image.LANCZOS)
ios.save(OUT_IOS)
if IOS_SLOT.parent.exists():
    ios.save(IOS_SLOT)
print(f'wrote {OUT}  body {right - left:.0f}x{bottom - top:.0f}px in the artwork, scaled {scale:.3f}')
