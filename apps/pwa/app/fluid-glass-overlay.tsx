"use client";

/* eslint-disable react/no-unknown-property */
import * as THREE from "three";
import { Canvas, createPortal, useFrame, useThree } from "@react-three/fiber";
import { MeshTransmissionMaterial } from "@react-three/drei/core/MeshTransmissionMaterial.js";
import { useFBO } from "@react-three/drei/core/Fbo.js";
import { useGLTF } from "@react-three/drei/core/Gltf.js";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";

const appBasePath = process.env.NEXT_PUBLIC_APP_BASE_PATH ?? "";
const barModelUrl = `${appBasePath}/assets/react-bits/bar.glb`;

const backdropVertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const backdropFragmentShader = `
  uniform float uTime;
  uniform float uMotion;
  varying vec2 vUv;

  void main() {
    vec2 uv = vUv;
    float time = uTime * uMotion;
    float driftA = sin(uv.x * 12.0 + sin(uv.y * 8.0 - time * 0.9) * 1.8 + time * 1.25);
    float driftB = sin(uv.y * 15.0 - cos(uv.x * 9.0 + time * 0.75) * 1.5 - time);
    float ridge = 1.0 - abs(0.5 * driftA + 0.5 * driftB);
    float caustic = smoothstep(0.58, 0.96, ridge);
    float base = mix(0.16, 0.44, smoothstep(0.0, 1.0, uv.y));
    float vignette = 1.0 - 0.16 * distance(uv, vec2(0.5));
    float value = (base + caustic * 0.2) * vignette;
    gl_FragColor = vec4(vec3(value), 1.0);
  }
`;

type BackdropMaterial = THREE.ShaderMaterial & {
  uniforms: {
    uTime: { value: number };
    uMotion: { value: number };
  };
};

function FluidBar({ reducedMotion }: { reducedMotion: boolean }) {
  const glassRef = useRef<THREE.Mesh>(null);
  const backdropRef = useRef<BackdropMaterial>(null);
  const { nodes } = useGLTF(barModelUrl);
  const buffer = useFBO({ samples: 2, depthBuffer: true });
  const { gl, camera, viewport } = useThree();
  const [backdropScene] = useState(() => new THREE.Scene());
  const geometry = (nodes.Cube as THREE.Mesh | undefined)?.geometry;
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uMotion: { value: reducedMotion ? 0 : 1 },
    }),
    [reducedMotion],
  );

  useEffect(() => {
    return () => {
      buffer.dispose();
    };
  }, [buffer]);

  useFrame((state) => {
    if (!geometry || !glassRef.current) return;

    const currentViewport = viewport.getCurrentViewport(camera, [0, 0, 15]);
    glassRef.current.scale.set(
      (currentViewport.width * 0.97) / 8.6156,
      1,
      (currentViewport.height * 0.88) / 1.2,
    );
    if (backdropRef.current) {
      backdropRef.current.uniforms.uTime.value = state.clock.elapsedTime;
      backdropRef.current.uniforms.uMotion.value = reducedMotion ? 0 : 1;
    }

    const previousTarget = gl.getRenderTarget();
    gl.setRenderTarget(buffer);
    gl.clear();
    gl.render(backdropScene, camera);
    gl.setRenderTarget(previousTarget);
  });

  if (!geometry) return null;

  const currentViewport = viewport.getCurrentViewport(camera, [0, 0, 0]);

  return (
    <>
      {createPortal(
        <mesh scale={[currentViewport.width, currentViewport.height, 1]}>
          <planeGeometry />
          <shaderMaterial
            ref={backdropRef}
            uniforms={uniforms}
            vertexShader={backdropVertexShader}
            fragmentShader={backdropFragmentShader}
          />
        </mesh>,
        backdropScene,
      )}
      <mesh ref={glassRef} position={[0, 0, 15]} rotation-x={Math.PI / 2} geometry={geometry}>
        <MeshTransmissionMaterial
          buffer={buffer.texture}
          transmission={1}
          roughness={0.04}
          thickness={10}
          ior={1.15}
          color="#f4f4f2"
          attenuationColor="#ffffff"
          attenuationDistance={0.25}
          chromaticAberration={0.045}
          anisotropy={0.012}
          distortion={0.42}
          distortionScale={0.82}
          temporalDistortion={reducedMotion ? 0 : 0.16}
          samples={6}
          transparent
          opacity={0.58}
        />
      </mesh>
    </>
  );
}

export function FluidGlassOverlay() {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return (
    <span className="ptt-fluid-overlay" aria-hidden>
      <Canvas
        camera={{ position: [0, 0, 20], fov: 15 }}
        dpr={[1, 1.5]}
        frameloop={reducedMotion ? "demand" : "always"}
        gl={{ alpha: true, antialias: true, powerPreference: "high-performance" }}
        onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
      >
        <Suspense fallback={null}>
          <FluidBar reducedMotion={reducedMotion} />
        </Suspense>
      </Canvas>
    </span>
  );
}

useGLTF.preload(barModelUrl);
