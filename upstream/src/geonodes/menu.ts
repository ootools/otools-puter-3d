// Add menu of the Geometry Node Editor (Group and Layout are appended by the node editor).
import { registerNodeMenu } from '../nodes/registry';
import type { MenuCategory, MenuEntry } from '../nodes/types';

const e = (idname: string, label?: string, settings?: MenuEntry['settings']): MenuEntry => ({
  idname,
  ...(label ? { label } : {}),
  ...(settings ? { settings } : {}),
});

export const GEOMETRY_MENU: MenuCategory[] = [
  {
    label: 'Attribute',
    items: [e('GeometryNodeAttributeStatistic'), e('GeometryNodeCaptureAttribute'), e('GeometryNodeStoreNamedAttribute')],
  },
  {
    label: 'Input',
    items: [
      {
        label: 'Constant',
        items: [e('FunctionNodeInputBool'), e('FunctionNodeInputInt'), e('FunctionNodeInputRotation'), e('FunctionNodeInputString'), e('ShaderNodeValue'), e('FunctionNodeInputVector')],
      },
      {
        label: 'Scene',
        items: [e('GeometryNodeCollectionInfo'), e('GeometryNodeIsViewport'), e('GeometryNodeObjectInfo'), e('GeometryNodeInputSceneTime'), e('GeometryNodeSelfObject')],
      },
    ],
  },
  { label: 'Output', items: [e('GeometryNodeViewer')] },
  {
    label: 'Geometry',
    items: [
      {
        label: 'Read',
        items: [
          e('GeometryNodeInputID'),
          e('GeometryNodeInputIndex'),
          e('GeometryNodeInputNamedAttribute'),
          e('GeometryNodeInputNormal'),
          e('GeometryNodeInputPosition'),
          e('GeometryNodeInputRadius'),
        ],
      },
      { label: 'Sample', items: [e('GeometryNodeSampleIndex')] },
      { label: 'Write', items: [e('GeometryNodeSetPosition')] },
      'SEPARATOR',
      e('GeometryNodeBoundBox'),
      e('GeometryNodeConvexHull'),
      e('GeometryNodeDeleteGeometry'),
      e('GeometryNodeMergeByDistance'),
      e('GeometryNodeSeparateComponents'),
      e('GeometryNodeSeparateGeometry'),
      e('GeometryNodeTransform'),
      'SEPARATOR',
      e('GeometryNodeJoinGeometry'),
    ],
  },
  {
    label: 'Curve',
    items: [
      {
        label: 'Read',
        items: [e('GeometryNodeCurveLength'), e('GeometryNodeInputSplineCyclic'), e('GeometryNodeSplineParameter')],
      },
      {
        label: 'Write',
        items: [e('GeometryNodeSetCurveRadius'), e('GeometryNodeSetSplineCyclic')],
      },
      {
        label: 'Operations',
        items: [e('GeometryNodeCurveToMesh'), e('GeometryNodeCurveToPoints'), e('GeometryNodeFillCurve'), e('GeometryNodeResampleCurve')],
      },
      {
        label: 'Primitives',
        items: [e('GeometryNodeCurvePrimitiveCircle'), e('GeometryNodeCurvePrimitiveLine'), e('GeometryNodeCurvePrimitiveQuadrilateral'), e('GeometryNodeCurveSpiral')],
      },
    ],
  },
  {
    label: 'Instances',
    items: [e('GeometryNodeInstanceOnPoints'), e('GeometryNodeRealizeInstances'), e('GeometryNodeRotateInstances'), e('GeometryNodeScaleInstances'), e('GeometryNodeTranslateInstances')],
  },
  {
    label: 'Mesh',
    items: [
      {
        label: 'Read',
        items: [e('GeometryNodeInputMeshEdgeAngle'), e('GeometryNodeInputMeshFaceArea'), e('GeometryNodeInputShadeSmooth'), e('GeometryNodeInputMaterialIndex')],
      },
      { label: 'Write', items: [e('GeometryNodeSetShadeSmooth')] },
      {
        label: 'Operations',
        items: [
          e('GeometryNodeExtrudeMesh'),
          e('GeometryNodeFlipFaces'),
          e('GeometryNodeMeshToCurve'),
          e('GeometryNodeMeshToPoints'),
          e('GeometryNodeSubdivideMesh'),
          e('GeometryNodeSubdivisionSurface'),
          e('GeometryNodeTriangulate'),
        ],
      },
    ],
  },
  {
    label: 'Mesh Primitives',
    items: [
      e('GeometryNodeMeshCone'),
      e('GeometryNodeMeshCube'),
      e('GeometryNodeMeshCylinder'),
      e('GeometryNodeMeshGrid'),
      e('GeometryNodeMeshIcoSphere'),
      e('GeometryNodeMeshCircle'),
      e('GeometryNodeMeshLine'),
      e('GeometryNodeMeshUVSphere'),
    ],
  },
  {
    label: 'Point',
    items: [e('GeometryNodeDistributePointsOnFaces'), e('GeometryNodePointsToVertices'), e('GeometryNodeSetPointRadius')],
  },
  {
    label: 'Material',
    items: [e('GeometryNodeSetMaterial'), e('GeometryNodeSetMaterialIndex')],
  },
  { label: 'Texture', items: [e('ShaderNodeTexNoise')] },
  {
    label: 'Utilities',
    items: [
      {
        label: 'Color',
        items: [e('ShaderNodeMix', 'Mix Color', { data_type: 'RGBA' })],
      },
      {
        label: 'Math',
        items: [e('FunctionNodeBooleanMath'), e('ShaderNodeClamp'), e('FunctionNodeCompare'), e('ShaderNodeFloatCurve'), e('ShaderNodeMapRange'), e('ShaderNodeMath'), e('ShaderNodeMix')],
      },
      {
        label: 'Rotation',
        items: [e('FunctionNodeEulerToRotation'), e('FunctionNodeRotationToEuler')],
      },
      'SEPARATOR',
      e('FunctionNodeRandomValue'),
      e('GeometryNodeSwitch'),
    ],
  },
  {
    label: 'Vector',
    items: [e('ShaderNodeCombineXYZ'), e('ShaderNodeMix', 'Mix Vector', { data_type: 'VECTOR' }), e('ShaderNodeSeparateXYZ'), e('ShaderNodeVectorMath')],
  },
];

registerNodeMenu(['GEOMETRY'], GEOMETRY_MENU);
