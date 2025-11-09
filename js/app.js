import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PCDLoader } from "three/addons/loaders/PCDLoader.js";
import { GUI } from "three/addons/libs/lil-gui.module.min.js";

const vtxShader = `
  attribute vec3 color;
  varying float vX;
  varying float vY;
  varying float vZ;
  varying vec3 vColor;
  uniform float size;
  uniform float marginMinZ;
  uniform float marginMaxZ;

  void main() {
    vX = position.x;
    vY = position.y;
    vZ = position.z;
    vColor = color;
    gl_PointSize = size;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragShader = `
  varying float vX;
  varying float vY;
  varying float vZ;
  varying vec3 vColor;
  uniform bool enableFilterX;
  uniform bool enableFilterY;
  uniform bool enableFilterZ;
  uniform bool useRgb;
  uniform float rgbBoost;
  uniform float marginMinX;
  uniform float marginMaxX;
  uniform float marginMinY;
  uniform float marginMaxY;
  uniform float marginMinZ;
  uniform float marginMaxZ;

  void main() {
    // Calculate normalization value for cloud coloring according to Z-value
    float normalizedZ = (vZ - marginMinZ) / (marginMaxZ - marginMinZ);
    float r = normalizedZ;

    // Filter out ground and roof planes
    if (enableFilterZ == true && (vZ < marginMinZ || vZ > marginMaxZ)) {
      discard;
    }

    // Filter XY points
    if (enableFilterX == true && (vX < marginMinX || vX > marginMaxX)) {
      discard;
    }
    if (enableFilterY == true && (vY < marginMinY || vY > marginMaxY)) {
      discard;
    }

    vec3 colorOut = vec3(r, 1.0 - r, 1.0 - r);
    if (useRgb) {
      // if RGB is supplied per-vertex, prefer it. Apply optional boost.
      colorOut = clamp(vColor * rgbBoost, 0.0, 1.0);
    }

    gl_FragColor = vec4(colorOut, 1.0);
  }
`;

let camera, scene, renderer;

init();
render();

let selectedDataset = "sp1f";

// Pre-defined margins for each POI from my thesis. Works only with default rotation.
const cloudMargins = {
  sp1f: {
    global: {
      x: [-50, 50],
      y: [-50, 50],
      z: [1.1, 3],
    },
    entrance: {
      x: [-1.9, 15.3],
      y: [7, 50],
      z: [1.1, 3],
    },
    elevator: {
      x: [-11, -1.2],
      y: [-1, 6.5],
      z: [1.1, 3],
    },
    glassDoors1: {
      x: [-16, -7],
      y: [8, 14],
      z: [1.1, 3],
    },
    glassDoors2: {
      x: [5, 20],
      y: [-11, -1],
      z: [1.1, 3],
    },
    glassDoors3: {
      x: [-21, -12],
      y: [-4, 3.5],
      z: [1.1, 3],
    },
  },
};

function init() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(
    30,
    window.innerWidth / window.innerHeight,
    0.01,
    300
  );

  camera.position.set(0, 0, 50);
  scene.add(camera);

  // Add coordinate axes at origin (0,0,0)
  // Red = X, Green = Y, Blue = Z
  const axesHelper = new THREE.AxesHelper(10); // 10 units length
  scene.add(axesHelper);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.addEventListener("change", render);
  
  // Standard 3D viewer mouse controls:
  // Left button = Rotate (orbit around target)
  // Middle button = Pan (move camera and target together)
  // Right button = Zoom (dolly in/out)
  // Wheel = Zoom (alternative)
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.PAN,
    RIGHT: THREE.MOUSE.DOLLY,
  };

  // Disable right-click context menu
  renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

  // Instant response (no damping/animation)
  controls.enableDamping = false;
  
  // Rotation settings - slower, smoother rotation
  controls.rotateSpeed = 0.3; // Reduced from default 1.0 for slower, easier control
  
  // Single-axis rotation mode
  // When dragging, lock to either horizontal or vertical axis based on initial movement
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let lockedAxis = null; // 'horizontal' or 'vertical'
  const axisLockThreshold = 10; // pixels
  
  const originalRotate = controls.constructor.prototype.rotateLeft;
  const originalRotateUp = controls.constructor.prototype.rotateUp;
  
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button === 0 && !e.shiftKey) {
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      lockedAxis = null;
    }
  });
  
  renderer.domElement.addEventListener('pointerup', () => {
    isDragging = false;
    lockedAxis = null;
  });
  
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (isDragging && lockedAxis === null) {
      const dx = Math.abs(e.clientX - dragStartX);
      const dy = Math.abs(e.clientY - dragStartY);
      
      if (dx > axisLockThreshold || dy > axisLockThreshold) {
        lockedAxis = dx > dy ? 'horizontal' : 'vertical';
      }
    }
  });
  
  // Override OrbitControls rotation to respect axis lock
  controls.constructor.prototype.rotateLeft = function(angle) {
    if (!isDragging || lockedAxis === null || lockedAxis === 'horizontal') {
      originalRotate.call(this, angle);
    }
  };
  
  controls.constructor.prototype.rotateUp = function(angle) {
    if (!isDragging || lockedAxis === null || lockedAxis === 'vertical') {
      originalRotateUp.call(this, angle);
    }
  };
  
  // Zoom settings
  controls.enableZoom = true;
  controls.zoomSpeed = 1.0;
  controls.minDistance = 0.1;
  controls.maxDistance = 500;

  // Point picking setup
  const raycaster = new THREE.Raycaster();
  raycaster.params.Points.threshold = 0.1;
  const pointer = new THREE.Vector2();

  // Shift+Left drag = Rotate around Z-axis (like rotate clockwise/anti-clockwise)
  let isShiftDragging = false;
  let lastMouseX = 0;
  const rotateSpeed = 0.005;

  // Hover marker (yellow)
  const hoverGeom = new THREE.BufferGeometry();
  const hoverPos = new Float32Array(3);
  hoverGeom.setAttribute("position", new THREE.BufferAttribute(hoverPos, 3));
  const hoverMaterial = new THREE.PointsMaterial({ size: 8, color: 0xffff00, transparent: true, opacity: 0.8 });
  const hoverMarker = new THREE.Points(hoverGeom, hoverMaterial);
  hoverMarker.visible = false;
  scene.add(hoverMarker);

  // Selection marker (red)
  const selectGeom = new THREE.BufferGeometry();
  const selectPos = new Float32Array(3);
  selectGeom.setAttribute("position", new THREE.BufferAttribute(selectPos, 3));
  const selectMaterial = new THREE.PointsMaterial({ size: 12, color: 0xff0000 });
  const selectionMarker = new THREE.Points(selectGeom, selectMaterial);
  selectionMarker.visible = false;
  scene.add(selectionMarker);

  const loader = new PCDLoader();
  let currentGUI = null;
  let currentXYZWidget = null;
  let filterBoundingBox = null; // Bounding box to show filtered area
  
  // Function to create or update bounding box
  function updateBoundingBox(minX, maxX, minY, maxY, minZ, maxZ, enableX, enableY, enableZ) {
    // Remove old bounding box if exists
    if (filterBoundingBox) {
      scene.remove(filterBoundingBox);
      filterBoundingBox.geometry.dispose();
      filterBoundingBox.material.dispose();
    }
    
    // Only create box if at least one filter is enabled
    if (!enableX && !enableY && !enableZ) {
      filterBoundingBox = null;
      return;
    }
    
    // Calculate box dimensions
    const width = maxX - minX;
    const height = maxY - minY;
    const depth = maxZ - minZ;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const centerZ = (minZ + maxZ) / 2;
    
    // Create box edges
    const geometry = new THREE.BoxGeometry(width, height, depth);
    const edges = new THREE.EdgesGeometry(geometry);
    const material = new THREE.LineBasicMaterial({ 
      color: 0x00ff00, 
      linewidth: 2,
      transparent: true,
      opacity: 0.8
    });
    
    filterBoundingBox = new THREE.LineSegments(edges, material);
    filterBoundingBox.position.set(centerX, centerY, centerZ);
    scene.add(filterBoundingBox);
    render();
  }
  
  // Function to load and display PCD file
  function loadPCDFile(url, filename) {
    // Remove existing GUI if any
    if (currentGUI) {
      currentGUI.destroy();
      currentGUI = null;
    }
    
    // Remove existing XYZ widget if any
    if (currentXYZWidget) {
      currentXYZWidget.remove();
      currentXYZWidget = null;
    }
    
    // Remove existing bounding box if any
    if (filterBoundingBox) {
      scene.remove(filterBoundingBox);
      filterBoundingBox.geometry.dispose();
      filterBoundingBox.material.dispose();
      filterBoundingBox = null;
    }
    
    // Remove all existing point clouds (except markers)
    const pointsToRemove = scene.children.filter(child => 
      child.type === 'Points' && 
      child !== hoverMarker && 
      child !== selectionMarker
    );
    pointsToRemove.forEach(points => {
      scene.remove(points);
      if (points.geometry) points.geometry.dispose();
      if (points.material) points.material.dispose();
    });
    
    // Hide markers
    hoverMarker.visible = false;
    selectionMarker.visible = false;
    
    loader.load(url, function (points) {
      // Update file name display
      const fileNameDisplay = document.getElementById('file-name-display');
      if (fileNameDisplay && filename) {
        fileNameDisplay.textContent = filename;
        fileNameDisplay.style.display = 'inline-block';
      }
      
      processPCDPoints(points);
    });
  }
  
  // Handle file input
  const fileInput = document.getElementById('pcd-file-input');
  const deleteButton = document.getElementById('delete-pcd-button');
  const exportButton = document.getElementById('export-pcd-button');
  const fileNameDisplay = document.getElementById('file-name-display');
  
  fileInput.addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (file) {
      const url = URL.createObjectURL(file);
      loadPCDFile(url, file.name);
      // Show buttons
      deleteButton.style.display = 'inline-block';
      exportButton.style.display = 'inline-block';
    }
  });
  
  // Handle delete button
  deleteButton.addEventListener('click', function() {
    // Remove GUI
    if (currentGUI) {
      currentGUI.destroy();
      currentGUI = null;
    }
    
    // Remove XYZ widget
    if (currentXYZWidget) {
      currentXYZWidget.remove();
      currentXYZWidget = null;
    }
    
    // Remove bounding box
    if (filterBoundingBox) {
      scene.remove(filterBoundingBox);
      filterBoundingBox.geometry.dispose();
      filterBoundingBox.material.dispose();
      filterBoundingBox = null;
    }
    
    // Remove all point clouds from scene (except markers)
    const pointsToRemove = scene.children.filter(child => 
      child.type === 'Points' && 
      child !== hoverMarker && 
      child !== selectionMarker
    );
    pointsToRemove.forEach(points => {
      scene.remove(points);
      if (points.geometry) points.geometry.dispose();
      if (points.material) points.material.dispose();
    });
    
    // Hide markers
    hoverMarker.visible = false;
    selectionMarker.visible = false;
    
    // Clear file input and hide buttons
    fileInput.value = '';
    fileNameDisplay.textContent = '';
    fileNameDisplay.style.display = 'none';
    deleteButton.style.display = 'none';
    exportButton.style.display = 'none';
    
    // Force render empty scene
    renderer.render(scene, camera);
  });
  
  // Handle export button
  exportButton.addEventListener('click', function() {
    // Find the current point cloud
    const pointCloud = scene.children.find(child => 
      child.type === 'Points' && 
      child !== hoverMarker && 
      child !== selectionMarker
    );
    
    if (!pointCloud) {
      alert('No point cloud loaded!');
      return;
    }
    
    exportFilteredPCD(pointCloud);
  });
  
  // Function to export filtered PCD
  function exportFilteredPCD(points) {
    const geometry = points.geometry;
    const material = points.material;
    const uniforms = material.uniforms;
    
    const positions = geometry.attributes.position.array;
    const colors = geometry.attributes.color ? geometry.attributes.color.array : null;
    
    const enableFilterX = uniforms.enableFilterX.value;
    const enableFilterY = uniforms.enableFilterY.value;
    const enableFilterZ = uniforms.enableFilterZ.value;
    const minX = uniforms.marginMinX.value;
    const maxX = uniforms.marginMaxX.value;
    const minY = uniforms.marginMinY.value;
    const maxY = uniforms.marginMaxY.value;
    const minZ = uniforms.marginMinZ.value;
    const maxZ = uniforms.marginMaxZ.value;
    
    // Filter points based on current filter settings
    const filteredPoints = [];
    const numPoints = positions.length / 3;
    
    for (let i = 0; i < numPoints; i++) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      
      // Apply filters
      if (enableFilterX && (x < minX || x > maxX)) continue;
      if (enableFilterY && (y < minY || y > maxY)) continue;
      if (enableFilterZ && (z < minZ || z > maxZ)) continue;
      
      const point = { x, y, z };
      if (colors) {
        point.r = Math.round(colors[i * 3] * 255);
        point.g = Math.round(colors[i * 3 + 1] * 255);
        point.b = Math.round(colors[i * 3 + 2] * 255);
      }
      filteredPoints.push(point);
    }
    
    if (filteredPoints.length === 0) {
      alert('No points remain after filtering!');
      return;
    }
    
    // Generate PCD file content
    const hasColor = filteredPoints[0].r !== undefined;
    let pcdContent = `# .PCD v0.7 - Point Cloud Data file format
VERSION 0.7
FIELDS x y z${hasColor ? ' rgb' : ''}
SIZE 4 4 4${hasColor ? ' 4' : ''}
TYPE F F F${hasColor ? ' U' : ''}
COUNT 1 1 1${hasColor ? ' 1' : ''}
WIDTH ${filteredPoints.length}
HEIGHT 1
VIEWPOINT 0 0 0 1 0 0 0
POINTS ${filteredPoints.length}
DATA ascii
`;
    
    // Add point data
    filteredPoints.forEach(pt => {
      if (hasColor) {
        // Pack RGB into single uint32
        const rgb = (pt.r << 16) | (pt.g << 8) | pt.b;
        pcdContent += `${pt.x} ${pt.y} ${pt.z} ${rgb}\n`;
      } else {
        pcdContent += `${pt.x} ${pt.y} ${pt.z}\n`;
      }
    });
    
    // Create download
    const blob = new Blob([pcdContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'filtered_' + (fileNameDisplay.textContent || 'pointcloud.pcd');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    console.log(`Exported ${filteredPoints.length} filtered points out of ${numPoints} total points`);
  }
  
  // Function to process loaded PCD points
  function processPCDPoints(points) {
    // Center the point cloud geometry at origin (0,0,0)
    points.geometry.center();
    
    // Reset all transformations: XYZ position and RPY (Roll, Pitch, Yaw) rotation
    points.position.set(0, 0, 0);
    points.rotation.set(0, 0, 0);
    points.scale.set(1, 1, 1);

    // Calculate actual min/max values from the loaded PCD
    const positions = points.geometry.attributes.position.array;
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i];
      const y = positions[i + 1];
      const z = positions[i + 2];
      
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    
    // Add small padding to the range
    const paddingX = (maxX - minX) * 0.05;
    const paddingY = (maxY - minY) * 0.05;
    const paddingZ = (maxZ - minZ) * 0.05;
    
    const defaultX = [minX - paddingX, maxX + paddingX];
    const defaultY = [minY - paddingY, maxY + paddingY];
    const defaultZ = [minZ - paddingZ, maxZ + paddingZ];
    
    console.log('PCD Bounds:', {
      x: `[${minX.toFixed(2)}, ${maxX.toFixed(2)}]`,
      y: `[${minY.toFixed(2)}, ${maxY.toFixed(2)}]`,
      z: `[${minZ.toFixed(2)}, ${maxZ.toFixed(2)}]`
    });

    // Ensure a 'color' attribute exists for the shader
    const geom = points.geometry;
    const hasRgbAttr = !!geom.getAttribute("rgb");
    const hasColorAttr = !!geom.getAttribute("color");
    if (!hasColorAttr && hasRgbAttr) {
      const rgbAttr = geom.getAttribute("rgb");
      const cloned = rgbAttr.clone ? rgbAttr.clone() : new THREE.Float32BufferAttribute(rgbAttr.array, rgbAttr.itemSize || 3);
      geom.setAttribute("color", cloned);
    }

    // Normalize/unpack color attribute
    const finalHasColor = !!geom.getAttribute("color");
    if (finalHasColor) {
      let colorAttr = geom.getAttribute('color');
      if (colorAttr.itemSize === 1) {
        const n = colorAttr.count;
        const src = colorAttr.array;
        const srcUint = new Uint32Array(src.buffer, src.byteOffset, src.byteLength / 4);
        const dst = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          const packed = srcUint[i];
          const r = (packed >> 16) & 0xff;
          const g = (packed >> 8) & 0xff;
          const b = packed & 0xff;
          dst[i * 3] = r / 255;
          dst[i * 3 + 1] = g / 255;
          dst[i * 3 + 2] = b / 255;
        }
        geom.setAttribute('color', new THREE.Float32BufferAttribute(dst, 3));
        colorAttr = geom.getAttribute('color');
      } else if (colorAttr.itemSize === 3) {
        const arr = colorAttr.array;
        let maxv = 0;
        for (let i = 0, L = arr.length; i < L; i++) {
          if (arr[i] > maxv) maxv = arr[i];
        }
        if (maxv > 1.0) {
          for (let i = 0, L = arr.length; i < L; i++) arr[i] = arr[i] / 255.0;
          colorAttr.needsUpdate = true;
        }
      }
    }

    const material = new THREE.ShaderMaterial({
      vertexShader: vtxShader,
      fragmentShader: fragShader,
      uniforms: {
        size: { value: 1.0 },
        enableFilterX: { value: true },
        enableFilterY: { value: true },
        enableFilterZ: { value: false },
        useRgb: { value: finalHasColor },
        rgbBoost: { value: 2.0 },
        marginMinX: { value: defaultX[0] },
        marginMaxX: { value: defaultX[1] },
        marginMinY: { value: defaultY[0] },
        marginMaxY: { value: defaultY[1] },
        marginMinZ: { value: defaultZ[0] },
        marginMaxZ: { value: defaultZ[1] },
      },
    });

    points.material = material;
    scene.add(points);

    // Shift+Left drag handler for Z-axis rotation
    renderer.domElement.addEventListener('pointerdown', (e) => {
      if (e.button === 0 && e.shiftKey) {
        isShiftDragging = true;
        lastMouseX = e.clientX;
        controls.enabled = false;
      }
    });

    renderer.domElement.addEventListener('pointerup', (e) => {
      if (isShiftDragging) {
        isShiftDragging = false;
        controls.enabled = true;
      }
    });

    renderer.domElement.addEventListener('pointermove', (e) => {
      if (isShiftDragging) {
        const dx = e.clientX - lastMouseX;
        const angle = dx * rotateSpeed;
        
        const zAxis = new THREE.Vector3(0, 0, 1);
        camera.position.applyAxisAngle(zAxis, -angle);
        camera.up.applyAxisAngle(zAxis, -angle);
        camera.lookAt(controls.target);
        
        lastMouseX = e.clientX;
        controls.update();
        render();
      }
    });

    // Hover and selection handlers
    function onPointerMove(event) {
      if (isShiftDragging) return;
      pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;

      raycaster.setFromCamera(pointer, camera);
      const intersects = raycaster.intersectObject(points);
      
      if (intersects.length > 0) {
        const pos = intersects[0].point;
        hoverPos[0] = pos.x;
        hoverPos[1] = pos.y;
        hoverPos[2] = pos.z;
        hoverGeom.attributes.position.needsUpdate = true;
        hoverMarker.visible = true;
        document.body.style.cursor = 'pointer';
        updateXYZWidgetWithPoint(pos);
      } else {
        hoverMarker.visible = false;
        document.body.style.cursor = '';
        updateXYZWidgetFromPointer(pointer);
      }
      render();
    }

    function onClick(event) {
      if (event.button !== 0) return;
      
      pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
      
      raycaster.setFromCamera(pointer, camera);
      const intersects = raycaster.intersectObject(points);
      
      if (intersects.length > 0) {
        const pos = intersects[0].point;
        const idx = intersects[0].index;
        
        selectPos[0] = pos.x;
        selectPos[1] = pos.y;
        selectPos[2] = pos.z;
        selectGeom.attributes.position.needsUpdate = true;
        selectionMarker.visible = true;
        
        console.log('Selected point:', idx, 'position:', pos);
        updateXYZWidgetWithPoint(pos);
      } else {
        selectionMarker.visible = false;
      }
      render();
    }

    function onDoubleClick() {
      camera.position.copy(initialCameraPos);
      controls.target.copy(initialCameraTarget);
      controls.update();
      render();
    }

    // Attach listeners
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('click', onClick);
    renderer.domElement.addEventListener('dblclick', onDoubleClick);

    let rotateClockwise = () => {
      points.geometry.rotateZ(-Math.PI / 4);
      render();
    };

    let rotateAntiClockwise = () => {
      points.geometry.rotateZ(Math.PI / 4);
      render();
    };

    const gui = new GUI();
    currentGUI = gui;

    // Store initial view for reset
    const initialCameraPos = camera.position.clone();
    const initialCameraTarget = controls.target.clone();
    
    const guiOptions = {
      lockPolar: false,
      lockAzimuth: false,
      rotateClockwise: rotateClockwise,
      rotateAntiClockwise: rotateAntiClockwise,
      resetView: () => {
        camera.position.copy(initialCameraPos);
        controls.target.copy(initialCameraTarget);
        controls.update();
        render();
      },
      applyPresetValues: () => {
        points.material.uniforms.enableFilterX.value = true;
        points.material.uniforms.marginMinX.value = -9.8;
        points.material.uniforms.marginMaxX.value = 7.9;
        
        points.material.uniforms.enableFilterY.value = true;
        points.material.uniforms.marginMinY.value = -8;
        points.material.uniforms.marginMaxY.value = 30;
        
        points.material.uniforms.enableFilterZ.value = true;
        points.material.uniforms.marginMinZ.value = -3.3;
        points.material.uniforms.marginMaxZ.value = 1;
        
        updateBoundingBox(
          points.material.uniforms.marginMinX.value,
          points.material.uniforms.marginMaxX.value,
          points.material.uniforms.marginMinY.value,
          points.material.uniforms.marginMaxY.value,
          points.material.uniforms.marginMinZ.value,
          points.material.uniforms.marginMaxZ.value,
          points.material.uniforms.enableFilterX.value,
          points.material.uniforms.enableFilterY.value,
          points.material.uniforms.enableFilterZ.value
        );
        
        gui.updateDisplay();
        render();
      },
      resetFilters: () => {
        // Reset to original bounds
        points.material.uniforms.marginMinX.value = defaultX[0];
        points.material.uniforms.marginMaxX.value = defaultX[1];
        points.material.uniforms.marginMinY.value = defaultY[0];
        points.material.uniforms.marginMaxY.value = defaultY[1];
        points.material.uniforms.marginMinZ.value = defaultZ[0];
        points.material.uniforms.marginMaxZ.value = defaultZ[1];
        
        // Disable all filters
        points.material.uniforms.enableFilterX.value = false;
        points.material.uniforms.enableFilterY.value = false;
        points.material.uniforms.enableFilterZ.value = false;
        
        // Remove bounding box
        if (filterBoundingBox) {
          scene.remove(filterBoundingBox);
          filterBoundingBox.geometry.dispose();
          filterBoundingBox.material.dispose();
          filterBoundingBox = null;
        }
        
        gui.updateDisplay();
        render();
      }
    };

    const folderGeneral = gui.addFolder("General");
    const folderX = gui.addFolder("X axis");
    const folderY = gui.addFolder("Y axis");
    const folderZ = gui.addFolder("Z axis");

    folderGeneral
      .add(points.material.uniforms.size, "value", 0.1, 5)
      .name("Point size")
      .onChange(render);
    folderGeneral
      .add(guiOptions, "lockPolar")
      .name("Lock polar angle")
      .onChange((value) => {
        if (value == true) {
          let polarAngle = controls.getPolarAngle();
          controls.minPolarAngle = polarAngle;
          controls.maxPolarAngle = polarAngle;
        } else {
          controls.minPolarAngle = 0;
          controls.maxPolarAngle = Math.PI;
        }
        render();
      });
    folderGeneral
      .add(guiOptions, "lockAzimuth")
      .name("Lock azimuthal angle")
      .onChange((value) => {
        if (value == true) {
          let azimuthalAngle = controls.getAzimuthalAngle();
          controls.minAzimuthAngle = azimuthalAngle;
          controls.maxAzimuthAngle = azimuthalAngle;
        } else {
          controls.minAzimuthAngle = 0;
          controls.maxAzimuthAngle = Infinity;
        }
        render();
      });
    folderGeneral
      .add(guiOptions, "rotateClockwise")
      .name("Rotate clockwise");
    folderGeneral
      .add(guiOptions, "rotateAntiClockwise")
      .name("Rotate anti-clockwise");
    folderGeneral
      .add(guiOptions, "resetView")
      .name("Reset View");
    folderGeneral
      .add(guiOptions, "applyPresetValues")
      .name("Apply Preset Filters");
    folderGeneral
      .add(guiOptions, "resetFilters")
      .name("Reset Filters");
    
    if (points.material.uniforms.useRgb) {
      folderGeneral
        .add(points.material.uniforms.useRgb, "value")
        .name("Use RGB color")
        .onChange(render);
      folderGeneral
        .add(points.material.uniforms.rgbBoost, "value", 0.5, 2)
        .name("RGB boost")
        .onChange(render);
    }
    
    folderX
      .add(points.material.uniforms.enableFilterX, "value")
      .name("Enable X filter")
      .onChange(() => {
        updateBoundingBox(
          points.material.uniforms.marginMinX.value,
          points.material.uniforms.marginMaxX.value,
          points.material.uniforms.marginMinY.value,
          points.material.uniforms.marginMaxY.value,
          points.material.uniforms.marginMinZ.value,
          points.material.uniforms.marginMaxZ.value,
          points.material.uniforms.enableFilterX.value,
          points.material.uniforms.enableFilterY.value,
          points.material.uniforms.enableFilterZ.value
        );
        render();
      });
    folderY
      .add(points.material.uniforms.enableFilterY, "value")
      .name("Enable Y filter")
      .onChange(() => {
        updateBoundingBox(
          points.material.uniforms.marginMinX.value,
          points.material.uniforms.marginMaxX.value,
          points.material.uniforms.marginMinY.value,
          points.material.uniforms.marginMaxY.value,
          points.material.uniforms.marginMinZ.value,
          points.material.uniforms.marginMaxZ.value,
          points.material.uniforms.enableFilterX.value,
          points.material.uniforms.enableFilterY.value,
          points.material.uniforms.enableFilterZ.value
        );
        render();
      });
    folderZ
      .add(points.material.uniforms.enableFilterZ, "value")
      .name("Enable Z filter")
      .onChange(() => {
        updateBoundingBox(
          points.material.uniforms.marginMinX.value,
          points.material.uniforms.marginMaxX.value,
          points.material.uniforms.marginMinY.value,
          points.material.uniforms.marginMaxY.value,
          points.material.uniforms.marginMinZ.value,
          points.material.uniforms.marginMaxZ.value,
          points.material.uniforms.enableFilterX.value,
          points.material.uniforms.enableFilterY.value,
          points.material.uniforms.enableFilterZ.value
        );
        render();
      });
    folderX
      .add(points.material.uniforms.marginMinX, "value", defaultX[0], defaultX[1], 0.01)
      .name("X min")
      .decimals(2)
      .onChange((value) => {
        // Ensure min doesn't exceed max
        if (value > points.material.uniforms.marginMaxX.value) {
          points.material.uniforms.marginMinX.value = points.material.uniforms.marginMaxX.value;
          gui.updateDisplay();
        }
        updateBoundingBox(
          points.material.uniforms.marginMinX.value,
          points.material.uniforms.marginMaxX.value,
          points.material.uniforms.marginMinY.value,
          points.material.uniforms.marginMaxY.value,
          points.material.uniforms.marginMinZ.value,
          points.material.uniforms.marginMaxZ.value,
          points.material.uniforms.enableFilterX.value,
          points.material.uniforms.enableFilterY.value,
          points.material.uniforms.enableFilterZ.value
        );
        render();
      });
    folderX
      .add(points.material.uniforms.marginMaxX, "value", defaultX[0], defaultX[1], 0.01)
      .name("X max")
      .decimals(2)
      .onChange((value) => {
        // Ensure max doesn't go below min
        if (value < points.material.uniforms.marginMinX.value) {
          points.material.uniforms.marginMaxX.value = points.material.uniforms.marginMinX.value;
          gui.updateDisplay();
        }
        updateBoundingBox(
          points.material.uniforms.marginMinX.value,
          points.material.uniforms.marginMaxX.value,
          points.material.uniforms.marginMinY.value,
          points.material.uniforms.marginMaxY.value,
          points.material.uniforms.marginMinZ.value,
          points.material.uniforms.marginMaxZ.value,
          points.material.uniforms.enableFilterX.value,
          points.material.uniforms.enableFilterY.value,
          points.material.uniforms.enableFilterZ.value
        );
        render();
      });
    folderY
      .add(points.material.uniforms.marginMinY, "value", defaultY[0], defaultY[1], 0.01)
      .name("Y min")
      .decimals(2)
      .onChange((value) => {
        // Ensure min doesn't exceed max
        if (value > points.material.uniforms.marginMaxY.value) {
          points.material.uniforms.marginMinY.value = points.material.uniforms.marginMaxY.value;
          gui.updateDisplay();
        }
        updateBoundingBox(
          points.material.uniforms.marginMinX.value,
          points.material.uniforms.marginMaxX.value,
          points.material.uniforms.marginMinY.value,
          points.material.uniforms.marginMaxY.value,
          points.material.uniforms.marginMinZ.value,
          points.material.uniforms.marginMaxZ.value,
          points.material.uniforms.enableFilterX.value,
          points.material.uniforms.enableFilterY.value,
          points.material.uniforms.enableFilterZ.value
        );
        render();
      });
    folderY
      .add(points.material.uniforms.marginMaxY, "value", defaultY[0], defaultY[1], 0.01)
      .name("Y max")
      .decimals(2)
      .onChange((value) => {
        // Ensure max doesn't go below min
        if (value < points.material.uniforms.marginMinY.value) {
          points.material.uniforms.marginMaxY.value = points.material.uniforms.marginMinY.value;
          gui.updateDisplay();
        }
        updateBoundingBox(
          points.material.uniforms.marginMinX.value,
          points.material.uniforms.marginMaxX.value,
          points.material.uniforms.marginMinY.value,
          points.material.uniforms.marginMaxY.value,
          points.material.uniforms.marginMinZ.value,
          points.material.uniforms.marginMaxZ.value,
          points.material.uniforms.enableFilterX.value,
          points.material.uniforms.enableFilterY.value,
          points.material.uniforms.enableFilterZ.value
        );
        render();
      });
    folderZ
      .add(points.material.uniforms.marginMinZ, "value", defaultZ[0], defaultZ[1], 0.01)
      .name("Z min")
      .decimals(2)
      .onChange((value) => {
        // Ensure min doesn't exceed max
        if (value > points.material.uniforms.marginMaxZ.value) {
          points.material.uniforms.marginMinZ.value = points.material.uniforms.marginMaxZ.value;
          gui.updateDisplay();
        }
        updateBoundingBox(
          points.material.uniforms.marginMinX.value,
          points.material.uniforms.marginMaxX.value,
          points.material.uniforms.marginMinY.value,
          points.material.uniforms.marginMaxY.value,
          points.material.uniforms.marginMinZ.value,
          points.material.uniforms.marginMaxZ.value,
          points.material.uniforms.enableFilterX.value,
          points.material.uniforms.enableFilterY.value,
          points.material.uniforms.enableFilterZ.value
        );
        render();
      });
    folderZ
      .add(points.material.uniforms.marginMaxZ, "value", defaultZ[0], defaultZ[1], 0.01)
      .name("Z max")
      .decimals(2)
      .onChange((value) => {
        // Ensure max doesn't go below min
        if (value < points.material.uniforms.marginMinZ.value) {
          points.material.uniforms.marginMaxZ.value = points.material.uniforms.marginMinZ.value;
          gui.updateDisplay();
        }
        updateBoundingBox(
          points.material.uniforms.marginMinX.value,
          points.material.uniforms.marginMaxX.value,
          points.material.uniforms.marginMinY.value,
          points.material.uniforms.marginMaxY.value,
          points.material.uniforms.marginMinZ.value,
          points.material.uniforms.marginMaxZ.value,
          points.material.uniforms.enableFilterX.value,
          points.material.uniforms.enableFilterY.value,
          points.material.uniforms.enableFilterZ.value
        );
        render();
      });
    gui.open();

    // Create XYZ widget
    const xyzWidget = document.createElement('div');
    xyzWidget.id = 'xyz-widget';
    currentXYZWidget = xyzWidget;
    xyzWidget.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div class="label"><strong>XYZ</strong></div>
        <div class="value" id="xyz-values">-</div>
      </div>
      <div class="bar-row">
        <div class="bars">
          <div class="bar x"><div class="bar-inner" id="bar-x"></div></div>
          <div class="bar y"><div class="bar-inner" id="bar-y"></div></div>
          <div class="bar z"><div class="bar-inner" id="bar-z"></div></div>
        </div>
      </div>
    `;
    document.body.appendChild(xyzWidget);

    const barX = document.getElementById('bar-x');
    const barY = document.getElementById('bar-y');
    const barZ = document.getElementById('bar-z');
    const xyzValues = document.getElementById('xyz-values');

    function norm(val, min, max) {
      if (max === min) return 0.5;
      return Math.max(0, Math.min(1, (val - min) / (max - min)));
    }

    function updateXYZWidgetWithPoint(pt) {
      const mx = cloudMargins[selectedDataset].global.x;
      const my = cloudMargins[selectedDataset].global.y;
      const mz = cloudMargins[selectedDataset].global.z;

      const nx = norm(pt.x, mx[0], mx[1]);
      const ny = norm(pt.y, my[0], my[1]);
      const nz = norm(pt.z, mz[0], mz[1]);

      barX.style.height = Math.max(6, Math.round(nx * 100)) + '%';
      barY.style.height = Math.max(6, Math.round(ny * 100)) + '%';
      barZ.style.height = Math.max(6, Math.round(nz * 100)) + '%';
      xyzValues.textContent = `${pt.x.toFixed(2)}, ${pt.y.toFixed(2)}, ${pt.z.toFixed(2)}`;
    }

    const _plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const _tmpPt = new THREE.Vector3();
    function updateXYZWidgetFromPointer(pointer) {
      raycaster.setFromCamera(pointer, camera);
      const ok = raycaster.ray.intersectPlane(_plane, _tmpPt);
      if (ok && _tmpPt) {
        updateXYZWidgetWithPoint(_tmpPt);
      } else {
        barX.style.height = '6%';
        barY.style.height = '6%';
        barZ.style.height = '6%';
        xyzValues.textContent = '-';
      }
    }

    render();
  }

  window.addEventListener("resize", onWindowResize);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  render();
}

function render() {
  renderer.render(scene, camera);
}
