import type { RobotAsset, RobotModel } from '../contracts.ts';
import { pose, vec } from '../math.ts';
import { createAssetModel } from './assets.ts';
import { mobileModel } from './mobile.ts';
export { createAssetModel, requireCapabilities } from './assets.ts';

export const armAsset: RobotAsset = {
  links: [
    { name: 'base', pose: pose(), shape: { kind: 'box', size: vec(.3,.3,.6), color: '#748399' }, mode: 'fixed' },
    { name: 'upper', pose: pose(.6,0,.3), shape: { kind: 'box', size: vec(1.2,.13,.13), color: '#78a6ff' }, mode: 'dynamic', mass: .6 },
    { name: 'forearm', pose: pose(1.65,0,.3), shape: { kind: 'box', size: vec(.9,.1,.1), color: '#5ce0ca' }, mode: 'dynamic', mass: .4 },
  ],
  joints: [
    { name: 'shoulder', parent: 'base', child: 'upper', kind: 'revolute', anchorParent: vec(0,0,.3), anchorChild: vec(-.6,0,0), axis: vec(0,-1,0), limits: [-1.2,1.4] },
    { name: 'elbow', parent: 'upper', child: 'forearm', kind: 'revolute', anchorParent: vec(.6,0,0), anchorChild: vec(-.45,0,0), axis: vec(0,-1,0), limits: [-1.5,1.5] },
  ],
};

/** Supported articulated fixture for link/joint/sensor/control tests; no locomotion policy. */
export const humanoidAsset: RobotAsset = {
  links: [
    { name: 'base', pose: pose(), shape: { kind: 'box', size: vec(.28,.4,.3), color: '#748399' }, mode: 'fixed' },
    { name: 'torso', pose: pose(0,0,.48), shape: { kind: 'box', size: vec(.28,.48,.66), color: '#78a6ff' }, mode: 'dynamic', mass: 2 },
    { name: 'head', pose: pose(0,0,1), shape: { kind: 'sphere', size: vec(.28,.28,.28), color: '#b7cdf5' }, mode: 'dynamic', mass: .3 },
    ...(['left','right'] as const).flatMap((side,index) => { const y = index === 0 ? .14 : -.14; return [
      { name: `${side}_thigh`, pose: pose(0,y,-.4), shape: { kind: 'box' as const, size: vec(.15,.14,.6), color: '#78a6ff' }, mode: 'dynamic' as const, mass: .6 },
      { name: `${side}_shin`, pose: pose(0,y,-1), shape: { kind: 'box' as const, size: vec(.13,.12,.6), color: '#5ce0ca' }, mode: 'dynamic' as const, mass: .4 },
      { name: `${side}_arm`, pose: pose(0,index === 0 ? .38 : -.38,.355), shape: { kind: 'box' as const, size: vec(.13,.13,.55), color: '#5ce0ca' }, mode: 'dynamic' as const, mass: .3 },
    ]; }),
  ],
  joints: [
    { name: 'spine', parent: 'base', child: 'torso', kind: 'fixed', anchorParent: vec(0,0,.15), anchorChild: vec(0,0,-.33), axis: vec(0,0,1) },
    { name: 'neck', parent: 'torso', child: 'head', kind: 'fixed', anchorParent: vec(0,0,.4), anchorChild: vec(0,0,-.12), axis: vec(0,0,1) },
    ...(['left','right'] as const).flatMap((side,index) => { const y = index === 0 ? .14 : -.14; return [
      { name: `${side}_hip`, parent: 'base', child: `${side}_thigh`, kind: 'revolute' as const, anchorParent: vec(0,y,-.1), anchorChild: vec(0,0,.3), axis: vec(0,1,0), limits: [-1,1] as [number,number] },
      { name: `${side}_knee`, parent: `${side}_thigh`, child: `${side}_shin`, kind: 'revolute' as const, anchorParent: vec(0,0,-.3), anchorChild: vec(0,0,.3), axis: vec(0,1,0), limits: [-1.5,1.5] as [number,number] },
      { name: `${side}_shoulder`, parent: 'torso', child: `${side}_arm`, kind: 'revolute' as const, anchorParent: vec(0,index === 0 ? .38 : -.38,.15), anchorChild: vec(0,0,.275), axis: vec(0,1,0), limits: [-1.5,1.5] as [number,number] },
    ]; }),
  ],
};

export const builtinModels: RobotModel[] = [mobileModel('drone'), mobileModel('rover'), createAssetModel('arm',armAsset), createAssetModel('humanoid',humanoidAsset), mobileModel('kinematic')];
