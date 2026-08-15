"use client";

/// <reference types="@webgpu/types" />
import { useEffect, useRef, useState } from "react";
import shaderSource from "./audio-reactive-orb.wgsl?raw";

type WaveLevels = readonly [number, number, number];
type RenderState = "loading" | "ready" | "fallback";

const DEFAULT_FLOW_SPEED = 0.66;
const MAX_FLOW_SPEED = 10;
const uniformSeed = new Float32Array([
  1, 1, 0, 0.6600000262260437, 0.7200000286102295, 0.36000001430511475, 3.700000047683716, 0.44999998807907104,
  2.049999952316284, 0.30000001192092896, 0.4399999976158142, 1.2999999523162842, 0.44999998807907104, 0.09000000357627869, 1, 15,
  0.004999999888241291, 0.49000000953674316, 0, 1, 0.6200000047683716, 0.03999999910593033, 0, 0,
  0.9686274528503418, 0.9843137264251709, 1, 1, 0.8392156958580017, 0.9098039269447327, 0.9686274528503418, 1,
  0.24705882370471954, 0.3764705955982208, 0.24313725531101227, 1, 0.20392157137393951, 0.5764706134796143, 0.22745098173618317, 1,
  1, 1, 1, 1, 1, 1, 1, 1,
  0.8392156958580017, 0.9098039269447327, 0.9686274528503418, 1, 0.3294117748737335, 0.5137255191802979, 0.3529411852359772, 1,
  0.9176470637321472, 0.95686274766922, 1, 1, 0.8627451062202454, 0.9176470637321472, 1, 1,
  0, 0, 0, 1, 0.43529412150382996, 0.6470588445663452, 0.9098039269447327, 1,
  0.9686274528503418, 0.9843137264251709, 1, 1, 0.9372549057006836, 0.9647058844566345, 0.9921568632125854, 1,
  0.8784313797950745, 0.9333333373069763, 0.9764705896377563, 1, 0.8313725590705872, 0.9019607901573181, 0.9686274528503418, 1,
  0.7333333492279053, 0.8352941274642944, 0.9529411792755127, 1, 0.6509804129600525, 0.7803921699523926, 0.9411764740943909, 1,
  0.529411792755127, 0.6901960968971252, 0.9215686321258545, 1, 0.43529412150382996, 0.6196078658103943, 0.9098039269447327, 1,
  0.43529412150382996, 0.6196078658103943, 0.9098039269447327, 1, 0.43529412150382996, 0.6196078658103943, 0.9098039269447327, 1,
  0.43529412150382996, 0.6196078658103943, 0.9098039269447327, 1, 0.43529412150382996, 0.6196078658103943, 0.9098039269447327, 1,
]);

function clampLevel(level: number) {
  return Math.min(1, Math.max(0, Number.isFinite(level) ? level : 0));
}

export function AudioReactiveOrb({ levels }: { levels: WaveLevels }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peakLevel = clampLevel(Math.max(...levels));
  const levelRef = useRef(peakLevel);
  const [renderState, setRenderState] = useState<RenderState>("loading");

  useEffect(() => {
    levelRef.current = peakLevel;
  }, [peakLevel]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let failed = false;
    let animationFrame = 0;
    let device: GPUDevice | null = null;
    let uniformBuffer: GPUBuffer | null = null;
    let uncapturedErrorHandler: ((event: GPUUncapturedErrorEvent) => void) | null = null;
    let lastFrameAt = performance.now();
    let fluidTime = 0;
    let flowSpeed = DEFAULT_FLOW_SPEED;

    const cancelFrame = () => {
      if (!animationFrame) return;
      cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    };

    const releaseGpu = () => {
      uniformBuffer?.destroy();
      uniformBuffer = null;
      if (device && uncapturedErrorHandler) {
        device.removeEventListener("uncapturederror", uncapturedErrorHandler);
      }
      device?.destroy();
      device = null;
    };

    const fallback = (error?: unknown) => {
      if (disposed || failed) return;
      failed = true;
      cancelFrame();
      releaseGpu();
      setRenderState("fallback");
      if (error) console.warn("[voice-orb] WebGPU fallback", error);
    };

    const start = async () => {
      if (!navigator.gpu) {
        fallback();
        return;
      }

      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter || disposed) {
        fallback();
        return;
      }

      device = await adapter.requestDevice();
      if (disposed) {
        device.destroy();
        return;
      }

      const context = canvas.getContext("webgpu");
      if (!context) {
        fallback(new Error("WebGPU canvas unavailable"));
        return;
      }

      const format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ device, format, alphaMode: "premultiplied" });
      const shader = device.createShaderModule({ code: shaderSource });
      const compilation = await shader.getCompilationInfo();
      if (disposed) {
        releaseGpu();
        return;
      }
      const compilationErrors = compilation.messages.filter((message) => message.type === "error");
      if (compilationErrors.length) {
        fallback(new Error(compilationErrors.map((message) => String(message.lineNum) + ":" + String(message.linePos) + " " + message.message).join("\n")));
        return;
      }

      const pipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module: shader, entryPoint: "vs_main" },
        fragment: { module: shader, entryPoint: "fs_main", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
      });
      const values = new Float32Array(uniformSeed);
      uniformBuffer = device.createBuffer({
        size: values.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
      });

      device.lost.then((info) => {
        if (!disposed && info.reason !== "destroyed") fallback(new Error(info.message || "WebGPU device lost"));
      });
      uncapturedErrorHandler = (event) => {
        event.preventDefault();
        fallback(event.error);
      };
      device.addEventListener("uncapturederror", uncapturedErrorHandler);

      const draw = (now: number) => {
        animationFrame = 0;
        if (disposed || failed || document.visibilityState === "hidden" || !device || !uniformBuffer) return;

        const deltaSeconds = Math.min(0.1, Math.max(0, (now - lastFrameAt) / 1000));
        lastFrameAt = now;
        const targetSpeed = DEFAULT_FLOW_SPEED
          + Math.pow(levelRef.current, 1.35) * (MAX_FLOW_SPEED - DEFAULT_FLOW_SPEED);
        const smoothing = 1 - Math.exp(-deltaSeconds * 7);
        flowSpeed += (targetSpeed - flowSpeed) * smoothing;
        fluidTime += deltaSeconds * flowSpeed;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
        const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }

        values[0] = width;
        values[1] = height;
        values[2] = fluidTime;
        values[3] = 1;
        device.queue.writeBuffer(uniformBuffer, 0, values);

        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: context.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();
        device.queue.submit([encoder.finish()]);
        animationFrame = requestAnimationFrame(draw);
      };

      const handleVisibility = () => {
        cancelFrame();
        if (document.visibilityState !== "visible" || disposed || failed) return;
        lastFrameAt = performance.now();
        animationFrame = requestAnimationFrame(draw);
      };
      document.addEventListener("visibilitychange", handleVisibility);
      setRenderState("ready");
      animationFrame = requestAnimationFrame(draw);

      return () => {
        document.removeEventListener("visibilitychange", handleVisibility);
      };
    };

    let removeVisibilityHandler: (() => void) | undefined;
    void start()
      .then((cleanup) => {
        if (disposed) cleanup?.();
        else removeVisibilityHandler = cleanup;
      })
      .catch(fallback);

    return () => {
      disposed = true;
      cancelFrame();
      removeVisibilityHandler?.();
      releaseGpu();
    };
  }, []);

  return (
    <div className="voice-orb" aria-hidden>
      <canvas ref={canvasRef} className={renderState === "ready" ? "ready" : ""} />
      {renderState !== "ready" && (
        <span className="voice-orb-fallback">
          {levels.map((level, index) => <i key={index} style={{ height: String(8 + level * 28) + "px" }} />)}
        </span>
      )}
    </div>
  );
}
