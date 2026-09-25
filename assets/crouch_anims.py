# Builds the crouch_idle and crouch_walk actions on the Splatter rig: the hips drop and
# lean forward on top of the idle pose, the head stays level, and IK places the feet
# (planted for crouch_idle, a stepping cycle in place for crouch_walk). The result is
# baked into plain keyframes. Rerunning replaces the two actions.
#
#   blender -b assets/character.blend --python assets/crouch_anims.py -- assets/character.blend
#
# Then export public/models/player.glb as before (glTF binary: Rig, Body and GunMount
# selected, deform bones only, animation mode "Actions"). CLIP_SPEED printed here is
# CROUCH_CLIP_SPEED in public/js/characters.js.
import bpy, math, sys, json
from mathutils import Matrix, Vector, Quaternion

OUT = sys.argv[sys.argv.index('--') + 1]
scene = bpy.context.scene
rig = bpy.data.objects['Rig']
S = rig.matrix_world.to_scale()[0]           # 0.9, armature space = world / S
idle = bpy.data.actions['idle']
for old in ('crouch_idle', 'crouch_walk'):
    if old in bpy.data.actions:
        bpy.data.actions.remove(bpy.data.actions[old])
LEG = ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot']
ALL = [pb.name for pb in rig.pose.bones]
for pb in rig.pose.bones:
    pb.rotation_mode = 'QUATERNION'

def upd():
    bpy.context.view_layer.update()

def rot_world(name, angle, axis):
    # Rotates a pose bone around a world axis through its head, on top of its pose.
    pb = rig.pose.bones[name]
    piv = pb.head.copy()
    pb.matrix = Matrix.Translation(piv) @ Matrix.Rotation(angle, 4, axis) @ Matrix.Translation(-piv) @ pb.matrix
    upd()

def move_world(name, d):
    pb = rig.pose.bones[name]
    pb.matrix = Matrix.Translation(Vector(d) / S) @ pb.matrix
    upd()

def wpos(name, tail=False):
    pb = rig.pose.bones[name]
    return rig.matrix_world @ (pb.tail if tail else pb.head)

# --- reference: idle frame 1 (standing, feet flat)
rig.animation_data.action = idle
scene.frame_set(1)
foot_rot = {}
ball = {}
for side in 'LR':
    n = 'LeftFoot' if side == 'L' else 'RightFoot'
    foot_rot[side] = (rig.matrix_world @ rig.pose.bones[n].matrix).to_quaternion()
    ball[side] = wpos('LeftToeBase' if side == 'L' else 'RightToeBase')
ankle0 = {'L': wpos('LeftFoot'), 'R': wpos('RightFoot')}
rig.animation_data.action = None

# --- IK setup: ankle targets, knee poles, flat-foot rotation targets
def empty(name):
    o = bpy.data.objects.new(name, None)
    scene.collection.objects.link(o)
    o.rotation_mode = 'QUATERNION'
    return o

tgt, pole, frot = {}, {}, {}
for side in 'LR':
    pre = 'Left' if side == 'L' else 'Right'
    tgt[side], pole[side], frot[side] = empty(f'IK_{side}'), empty(f'Pole_{side}'), empty(f'FootRot_{side}')
    ik = rig.pose.bones[f'{pre}Leg'].constraints.new('IK')
    ik.target, ik.chain_count, ik.pole_target = tgt[side], 2, pole[side]
    cr = rig.pose.bones[f'{pre}Foot'].constraints.new('COPY_ROTATION')
    cr.target = frot[side]

def set_feet(ankles, pitches):
    # ankles: world positions of the flat foot; pitch > 0 lifts the heel around the ball.
    for side in 'LR':
        a, p = Vector(ankles[side]), pitches[side]
        if p > 0:
            b = a + (ball[side] - ankle0[side])
            a = b + Matrix.Rotation(p, 3, 'X') @ (a - b)
        tgt[side].location = a
        frot[side].rotation_quaternion = Quaternion((1, 0, 0), p) @ foot_rot[side]
        hip = wpos('LeftUpLeg' if side == 'L' else 'RightUpLeg')
        pole[side].location = (hip.x + (0.05 if side == 'L' else -0.05), hip.y - 1.0, (hip.z + a.z) / 2)
    upd()

# Knee pole angle: the one that bends the knees forward (-Y) without splaying them.
rig.animation_data.action = idle
scene.frame_set(1)
rig.animation_data.action = None
move_world('Hips', (0, 0, -0.35))
best = None
for deg in range(-180, 180, 15):
    for side in 'LR':
        pre = 'Left' if side == 'L' else 'Right'
        rig.pose.bones[f'{pre}Leg'].constraints['IK'].pole_angle = math.radians(deg)
    set_feet(ankle0, {'L': 0, 'R': 0})
    kl, kr = wpos('LeftLeg'), wpos('RightLeg')
    score = kl.y + kr.y + 2 * (abs(kl.x - ankle0['L'].x) + abs(kr.x - ankle0['R'].x))
    if best is None or score < best[0]:
        best = (score, deg)
for side in 'LR':
    pre = 'Left' if side == 'L' else 'Right'
    rig.pose.bones[f'{pre}Leg'].constraints['IK'].pole_angle = math.radians(best[1])
print('POLE', best)

def bake(name, frames, pose_fn):
    # pose_fn(i, t) poses the rig for frame i (upper body, hips, feet); constraints solve
    # the legs. Records the final pose, then keys it without constraints.
    recs = []
    for i, f in enumerate(frames):
        pose_fn(i, f)
        rec = {n: rig.pose.bones[n].matrix_basis.copy() for n in ALL if n not in LEG}
        rec.update({n: rig.pose.bones[n].matrix.copy() for n in LEG})
        recs.append(rec)
    for side in 'LR':
        pre = 'Left' if side == 'L' else 'Right'
        for bn in (f'{pre}Leg', f'{pre}Foot'):
            for c in list(rig.pose.bones[bn].constraints):
                rig.pose.bones[bn].constraints.remove(c)
    rig.animation_data.action = None
    prev = {}
    for i, rec in enumerate(recs):
        for n in ALL:
            if n not in LEG:
                rig.pose.bones[n].matrix_basis = rec[n]
        upd()
        for n in LEG:
            rig.pose.bones[n].matrix = rec[n]
            upd()
        for n in ALL:
            pb = rig.pose.bones[n]
            q = pb.rotation_quaternion.copy()
            if n in prev and q.dot(prev[n]) < 0:
                q.negate()
                pb.rotation_quaternion = q
            prev[n] = q
            pb.keyframe_insert('location', frame=i + 1, group=n)
            pb.keyframe_insert('rotation_quaternion', frame=i + 1, group=n)
    act = rig.animation_data.action
    act.name = name
    act.use_fake_user = True
    for fc in (act.layers[0].strips[0].channelbags[0].fcurves if act.layers else act.fcurves):
        for k in fc.keyframe_points:
            k.interpolation = 'LINEAR'
    rig.animation_data.action = None
    return act

def restore_constraints():
    for side in 'LR':
        pre = 'Left' if side == 'L' else 'Right'
        ik = rig.pose.bones[f'{pre}Leg'].constraints.new('IK')
        ik.target, ik.chain_count, ik.pole_target = tgt[side], 2, pole[side]
        ik.pole_angle = math.radians(best[1])
        cr = rig.pose.bones[f'{pre}Foot'].constraints.new('COPY_ROTATION')
        cr.target = frot[side]

DROP = 0.32      # hips lower (m)
BACK = 0.08      # and further back, to balance the forward lean
LEAN = 0.36      # pelvis tilts forward (rad)
LEAN_SPINE = 0.20

def crouch_body(sway=(0, 0, 0), yaw=0.0, bob=0.0, twist=0.0):
    move_world('Hips', (sway[0], BACK + sway[1], -DROP + bob))
    if yaw:
        rot_world('Hips', yaw, 'Z')
    rot_world('Hips', LEAN, 'X')
    rot_world('LowerBack', LEAN_SPINE, 'X')
    if twist:
        rot_world('Spine', twist, 'Z')
    # keep the head level, looking ahead
    rot_world('Neck1', -(LEAN + LEAN_SPINE) * 0.85, 'X')

# ---- crouch_idle: idle's breathing and sway on top, feet planted
IDLE_STANCE = {
    'L': ankle0['L'] + Vector((0.03, -0.10, 0)),
    'R': ankle0['R'] + Vector((-0.03, 0.08, 0)),
}
def pose_idle(i, f):
    rig.animation_data.action = idle
    scene.frame_set(f)
    rig.animation_data.action = None
    crouch_body()
    set_feet(IDLE_STANCE, {'L': 0, 'R': 0.12})   # back heel slightly up
act_idle = bake('crouch_idle', list(range(1, 66)), pose_idle)

# ---- crouch_walk: in place, feet slide back while planted (like the run clip)
restore_constraints()
N = 24          # frames per cycle (0.8 s)
DUTY = 0.62     # share of the cycle a foot is on the ground
STRIDE = 0.8    # how far a planted foot travels (m)
LIFT = 0.13
SPEED = STRIDE / (DUTY * N / scene.render.fps)
print('CLIP_SPEED', SPEED)

def smooth(x):
    x = min(1, max(0, x))
    return x * x * (3 - 2 * x)

def foot(phase, base):
    # phase 0 = heel strike, foot forward (-Y)
    if phase < DUTY:
        s = phase / DUTY
        y = -STRIDE / 2 + STRIDE * s
        z = 0
        pitch = -0.18 * (1 - smooth(s / 0.15)) + 0.55 * smooth((s - 0.7) / 0.3)
    else:
        u = (phase - DUTY) / (1 - DUTY)
        y = STRIDE / 2 - STRIDE * smooth(u)
        z = LIFT * math.sin(math.pi * min(1, u * 1.1))
        pitch = 0.55 + (-0.18 - 0.55) * smooth(u / 0.8)
    return base + Vector((0, y, z)), pitch

WALK_BASE = {'L': ankle0['L'] + Vector((0.02, -0.08, 0)), 'R': ankle0['R'] + Vector((-0.02, -0.08, 0))}
def pose_walk(i, f):
    t = (i % N) / N
    rig.animation_data.action = idle
    scene.frame_set(1)
    rig.animation_data.action = None
    ph = {'L': t, 'R': (t + 0.5) % 1}
    ank, pit = {}, {}
    for side in 'LR':
        ank[side], pit[side] = foot(ph[side], WALK_BASE[side])
    crouch_body(
        sway=(0.022 * math.cos(2 * math.pi * (t - 0.3)), 0, 0),
        yaw=-0.12 * math.cos(2 * math.pi * t),
        bob=-0.025 * math.cos(4 * math.pi * t),
        twist=0.09 * math.cos(2 * math.pi * t),
    )
    set_feet(ank, pit)
act_walk = bake('crouch_walk', list(range(1, N + 2)), pose_walk)

for o in list(tgt.values()) + list(pole.values()) + list(frot.values()):
    bpy.data.objects.remove(o)
rig.animation_data.action = idle

# measurements for the game: head position crouched (idle frame 1)
rig.animation_data.action = act_idle
scene.frame_set(1)
info = {'head': list(wpos('Head')), 'headTop': list(wpos('Head', True)), 'clipSpeed': SPEED,
        'hipsZ': wpos('LeftUpLeg').z}
for f in (1, 7, 13, 19):
    rig.animation_data.action = act_walk
    scene.frame_set(f)
    info[f'walk{f}'] = {'ankleL': list(wpos('LeftFoot')), 'ankleR': list(wpos('RightFoot')), 'kneeL': list(wpos('LeftLeg')), 'head': list(wpos('Head'))}
rig.animation_data.action = idle
scene.frame_set(1)
print('INFO', json.dumps(info))
bpy.ops.wm.save_as_mainfile(filepath=OUT, copy=True)
