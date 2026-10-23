package dev.hongguo.sign;

import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONObject;
import com.github.unidbg.AndroidEmulator;
import com.github.unidbg.Emulator;
import com.github.unidbg.Module;
import com.github.unidbg.arm.backend.Unicorn2Factory;
import com.github.unidbg.file.FileResult;
import com.github.unidbg.file.IOResolver;
import com.github.unidbg.file.linux.AndroidFileIO;
import com.github.unidbg.linux.android.AndroidEmulatorBuilder;
import com.github.unidbg.linux.android.AndroidResolver;
import com.github.unidbg.linux.android.dvm.AbstractJni;
import com.github.unidbg.linux.android.dvm.BaseVM;
import com.github.unidbg.linux.android.dvm.DalvikModule;
import com.github.unidbg.linux.android.dvm.DvmClass;
import com.github.unidbg.linux.android.dvm.DvmObject;
import com.github.unidbg.linux.android.dvm.StringObject;
import com.github.unidbg.linux.android.dvm.VM;
import com.github.unidbg.linux.android.dvm.VaList;
import com.github.unidbg.linux.android.dvm.VarArg;
import com.github.unidbg.linux.android.dvm.array.ArrayObject;
import com.github.unidbg.linux.android.dvm.array.ByteArray;
import com.github.unidbg.linux.android.dvm.wrapper.DvmBoolean;
import com.github.unidbg.linux.file.SimpleFileIO;
import com.github.unidbg.memory.Memory;
import com.github.unidbg.pointer.UnidbgPointer;
import com.github.unidbg.virtualmodule.android.AndroidModule;
import com.github.unidbg.virtualmodule.android.JniGraphics;
import com.sun.net.httpserver.HttpServer;

import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/**
 * Minimal unidbg harness for ByteDance's libmetasec_ml.so.
 *
 * <p>It emulates a 64-bit Android process and exposes the native signing entry
 * over a local HTTP endpoint. No application logic is taken from any existing
 * client; only the observed native contract is implemented.
 */
public final class MetasecHarness extends AbstractJni implements IOResolver<AndroidFileIO> {

    private static final String PKG = "com.dragon.read.oversea.gp";
    private static final String FILES = "/data/user/0/" + PKG + "/files";
    private static final long SIGN_ENTRY = 0x168C80L;
    private static final int VERSION_CODE = 68132;
    private static final String VERSION_NAME = "6.8.1.32";

    private final Path root;
    private final File soMeta;
    private final File soCpp;
    private final File cert;

    private final AndroidEmulator emulator;
    private final VM vm;
    private final Module module;
    private final Memory memory;

    public MetasecHarness(Path root) throws Exception {
        this.root = root;
        this.soMeta = root.resolve("libmetasec_ml.so").toFile();
        this.soCpp = root.resolve("libc++_shared.so").toFile();
        this.cert = root.resolve("ms_16777218.bin").toFile();
        if (!soMeta.isFile()) {
            throw new IllegalStateException("missing libmetasec_ml.so under " + root);
        }

        this.emulator = AndroidEmulatorBuilder.for64Bit()
                .addBackendFactory(new Unicorn2Factory(true))
                .setProcessName(PKG)
                .build();
        this.emulator.getSyscallHandler().setVerbose(false);
        this.emulator.getSyscallHandler().addIOResolver(this);

        Map<String, Integer> inode = new HashMap<>();
        inode.put("/data/user/0/" + PKG, 655781);
        inode.put(FILES, 655864);
        this.emulator.set("inode", inode);
        this.emulator.set("uid", 10074);

        this.memory = this.emulator.getMemory();
        this.memory.setLibraryResolver(new AndroidResolver(23, new String[0]));

        this.vm = this.emulator.createDalvikVM();
        this.vm.setJni(this);
        this.vm.setVerbose(false);

        new AndroidModule(this.emulator, this.vm).register(this.memory);
        new JniGraphics(this.emulator, this.vm).register(this.memory);

        if (soCpp.isFile()) {
            this.vm.loadLibrary(soCpp, false);
        }

        DvmClass ms = this.vm.resolveClass("ms/bd/c/m", new DvmClass[0]);
        DvmClass a4a = this.vm.resolveClass("ms/bd/c/a4$a", ms);
        this.vm.resolveClass("com/bytedance/mobsec/metasec/ml/MS", a4a);

        DalvikModule dm = this.vm.loadLibrary(soMeta, true);
        this.module = dm.getModule();
        dm.callJNI_OnLoad(this.emulator);
        System.out.println("[signer] libmetasec loaded base=0x"
                + Long.toHexString(this.module.base));
    }

    /** Raw native call: url + "k\r\nv..." -> multi-line "X-Name\nvalue". */
    public String sign(String url, String headerBlob) {
        Number n = this.module.callFunction(this.emulator, SIGN_ENTRY, url, headerBlob);
        if (n == null) {
            return null;
        }
        UnidbgPointer p = this.memory.pointer(n.longValue());
        return p == null ? null : p.getString(0L);
    }

    /** Parses the native output into an ordered header map. */
    public Map<String, String> signMap(String url, String headerBlob) {
        Map<String, String> out = new LinkedHashMap<>();
        String sig = sign(url, headerBlob);
        if (sig == null) {
            return out;
        }
        String[] lines = sig.split("\n");
        for (int i = 0; i + 1 < lines.length; i += 2) {
            String key = lines[i].trim();
            if (key.startsWith("X-")) {
                out.put(key, lines[i + 1].trim());
            }
        }
        return out;
    }

    private DvmObject<?> msValue(BaseVM vm, int op) {
        switch (op) {
            case 65539:
                return new StringObject(vm, FILES + "/.msdata");
            case 0x2000001:
            case 0x2000002:
                return DvmBoolean.valueOf(vm, true);
            case 0x1000010:
                return vm.resolveClass("java/lang/Integer", new DvmClass[0])
                        .newObject(VERSION_CODE);
            case 0x1000011:
                return new StringObject(vm, VERSION_NAME);
            case 0x1000002:
                try {
                    if (cert.isFile()) {
                        return new ByteArray(vm, Files.readAllBytes(cert.toPath()));
                    }
                } catch (Exception ignored) {
                    // The SDK treats absent certificate bytes as an optional input.
                }
                return null;
            case 0x1000000E:
                return vm.resolveClass("java/lang/Long", new DvmClass[0])
                        .newObject(System.currentTimeMillis());
            default:
                return null;
        }
    }

    @Override
    public DvmObject<?> callStaticObjectMethodV(BaseVM vm, DvmClass dvmClass,
                                                String signature, VaList vaList) {
        if (signature.startsWith("com/bytedance/mobsec/metasec/ml/MS->b(")) {
            return msValue(vm, vaList.getIntArg(0));
        }
        if (signature.equals("java/lang/Thread->currentThread()Ljava/lang/Thread;")) {
            return vm.resolveClass("java/lang/Thread", new DvmClass[0])
                    .newObject(Thread.currentThread());
        }
        if (signature.equals("java/lang/Boolean->valueOf(Z)Ljava/lang/Boolean;")) {
            return DvmBoolean.valueOf(vm, vaList.getIntArg(0) != 0);
        }
        if (signature.equals("java/lang/Integer->valueOf(I)Ljava/lang/Integer;")) {
            return vm.resolveClass("java/lang/Integer", new DvmClass[0])
                    .newObject(vaList.getIntArg(0));
        }
        if (signature.equals("java/lang/Long->valueOf(J)Ljava/lang/Long;")) {
            return vm.resolveClass("java/lang/Long", new DvmClass[0])
                    .newObject(vaList.getLongArg(0));
        }
        return super.callStaticObjectMethodV(vm, dvmClass, signature, vaList);
    }

    @Override
    public DvmObject<?> callObjectMethodV(BaseVM vm, DvmObject<?> object,
                                          String signature, VaList vaList) {
        switch (signature) {
            case "java/lang/Thread->getStackTrace()[Ljava/lang/StackTraceElement;": {
                StackTraceElement[] elements = Thread.currentThread().getStackTrace();
                DvmObject<?>[] array = new DvmObject<?>[elements.length];
                for (int i = 0; i < elements.length; i++) {
                    array[i] = vm.resolveClass("java/lang/StackTraceElement", new DvmClass[0])
                            .newObject(elements[i]);
                }
                return new ArrayObject(array);
            }
            case "java/lang/StackTraceElement->getClassName()Ljava/lang/String;":
                return new StringObject(vm, ((StackTraceElement) object.getValue()).getClassName());
            case "java/lang/StackTraceElement->getMethodName()Ljava/lang/String;":
                return new StringObject(vm, ((StackTraceElement) object.getValue()).getMethodName());
            case "java/lang/Thread->getBytes(Ljava/lang/String;)[B": {
                String charset = (String) ((DvmObject<?>) vaList.getObjectArg(0)).getValue();
                return new ByteArray(vm, charset.getBytes(StandardCharsets.UTF_8));
            }
            default:
                return super.callObjectMethodV(vm, object, signature, vaList);
        }
    }

    @Override
    public long callLongMethodV(BaseVM vm, DvmObject<?> object, String signature, VaList vaList) {
        if ("java/lang/Long->longValue()J".equals(signature) && object.getValue() instanceof Long) {
            return (Long) object.getValue();
        }
        return super.callLongMethodV(vm, object, signature, vaList);
    }

    @Override
    public int callIntMethodV(BaseVM vm, DvmObject<?> object, String signature, VaList vaList) {
        if ("java/lang/Integer->intValue()I".equals(signature)
                && object.getValue() instanceof Integer) {
            return (Integer) object.getValue();
        }
        return super.callIntMethodV(vm, object, signature, vaList);
    }

    @Override
    public boolean callBooleanMethodV(BaseVM vm, DvmObject<?> object,
                                      String signature, VaList vaList) {
        if ("java/lang/Boolean->booleanValue()Z".equals(signature)
                && object.getValue() instanceof Boolean) {
            return (Boolean) object.getValue();
        }
        return super.callBooleanMethodV(vm, object, signature, vaList);
    }

    @Override
    public int getStaticIntField(BaseVM vm, DvmClass dvmClass, String signature) {
        if (signature.contains("MS->a()V")) {
            return 64;
        }
        return super.getStaticIntField(vm, dvmClass, signature);
    }

    @Override
    public void callVoidMethod(BaseVM vm, DvmObject<?> object, String signature, VarArg varArg) {
        if (signature.contains("MS->a()V")) {
            return;
        }
        super.callVoidMethod(vm, object, signature, varArg);
    }

    @Override
    public FileResult<AndroidFileIO> resolve(Emulator<AndroidFileIO> emulator, String pathname, int oflags) {
        if (pathname != null && pathname.contains("libmetasec_ml.so")) {
            return FileResult.success(new SimpleFileIO(oflags, soMeta, pathname));
        }
        return null;
    }

    private static byte[] readAll(InputStream in) throws Exception {
        return in.readAllBytes();
    }

    private static void writeJson(com.sun.net.httpserver.HttpExchange exchange, Object value)
            throws Exception {
        byte[] body = JSON.toJSONString(value).getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/json");
        exchange.sendResponseHeaders(200, body.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(body);
        }
    }

    private static void serve(Path root, int port) throws Exception {
        MetasecHarness harness = new MetasecHarness(root);
        ExecutorService signer = Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "metasec-signer");
            t.setDaemon(true);
            return t;
        });
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        server.createContext("/sign", exchange -> {
            try {
                JSONObject req = JSON.parseObject(
                        new String(readAll(exchange.getRequestBody()), StandardCharsets.UTF_8));
                String url = req.getString("url");
                JSONObject headers = req.getJSONObject("headers");
                StringBuilder blob = new StringBuilder();
                if (headers != null) {
                    for (String key : headers.keySet()) {
                        if (blob.length() > 0) {
                            blob.append("\r\n");
                        }
                        blob.append(key).append("\r\n").append(headers.getString(key));
                    }
                }
                Future<Map<String, String>> task = signer.submit(
                        () -> harness.signMap(url, blob.toString()));
                writeJson(exchange, task.get(120, TimeUnit.SECONDS));
            } catch (Throwable t) {
                Map<String, String> error = new LinkedHashMap<>();
                error.put("error", String.valueOf(t.getMessage()).replace('"', '\''));
                try {
                    writeJson(exchange, error);
                } catch (Exception ignored) {
                    // The client is gone; nothing else to do.
                }
            }
        });
        server.setExecutor(Executors.newFixedThreadPool(4));
        server.start();
        System.out.println("[signer] listening 127.0.0.1:" + port);
    }

    public static void main(String[] args) throws Exception {
        String rootArg = System.getProperty("signer.root", "lib");
        Path root = Paths.get(rootArg).toAbsolutePath();
        if (args.length >= 1 && "serve".equals(args[0])) {
            int port = args.length >= 2 ? Integer.parseInt(args[1]) : 19099;
            serve(root, port);
            return;
        }
        if (args.length >= 1 && "sign".equals(args[0])) {
            MetasecHarness harness = new MetasecHarness(root);
            String url = args[1];
            String blob = args.length >= 3 ? args[2] : "";
            System.out.println(JSON.toJSONString(harness.signMap(url, blob)));
            return;
        }
        System.out.println("usage: MetasecHarness serve <port> | sign <url> [headerBlob]");
        System.out.println("       -Dsigner.root=<dir containing libmetasec_ml.so>");
    }
}
