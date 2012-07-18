/**
 * Copyright 2011-2012 the original author or authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package org.informantproject.testkit;

import java.io.File;
import java.io.IOException;
import java.io.ObjectInputStream;
import java.io.ObjectOutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.concurrent.ExecutorService;

import org.informantproject.api.Logger;
import org.informantproject.api.LoggerFactory;
import org.informantproject.core.util.DaemonExecutors;
import org.informantproject.testkit.InformantContainer.ExecutionAdapter;

import com.google.common.base.Strings;
import com.google.common.io.ByteStreams;

/**
 * @author Trask Stalnaker
 * @since 0.5
 */
class ExternalJvmExecutionAdapter implements ExecutionAdapter {

    private static final Logger logger = LoggerFactory.getLogger(ExternalJvmExecutionAdapter.class);

    private final Process process;
    private final ExecutorService executorService;

    private final Socket socket;
    private final ObjectOutputStream objectOut;
    private final ObjectInputStream objectIn;

    ExternalJvmExecutionAdapter(String agentArgs) throws IOException {
        String classpath = System.getProperty("java.class.path");
        String path = System.getProperty("java.home") + File.separator + "bin" + File.separator
                + "java";
        String javaagentArg = "-javaagent:" + findInformantCoreJarPath(classpath);
        if (!Strings.isNullOrEmpty(agentArgs)) {
            javaagentArg += "=" + agentArgs;
        }
        ServerSocket serverSocket = new ServerSocket(0);
        ProcessBuilder processBuilder = new ProcessBuilder(path, "-cp", classpath, javaagentArg,
                ExternalJvmExecutionAdapter.class.getName(), Integer.toString(serverSocket
                        .getLocalPort()));
        processBuilder.redirectErrorStream(true);
        process = processBuilder.start();
        executorService = DaemonExecutors.newSingleThreadExecutor("ExternalMainPipe");
        executorService.submit(new Runnable() {
            public void run() {
                try {
                    ByteStreams.copy(process.getInputStream(), System.out);
                } catch (IOException e) {
                    logger.error(e.getMessage(), e);
                }
            }
        });
        socket = serverSocket.accept();
        objectOut = new ObjectOutputStream(socket.getOutputStream());
        objectIn = new ObjectInputStream(socket.getInputStream());
    }

    public int getPort() throws IOException, ClassNotFoundException {
        objectOut.writeObject(SocketCommandProcessor.GET_PORT_COMMAND);
        return (Integer) getNextNonPingValue();
    }

    private Object getNextNonPingValue() throws IOException, ClassNotFoundException {
        while (true) {
            Object value = objectIn.readObject();
            if (value == null || !value.equals(SocketHeartbeat.PING_COMMAND)) {
                return value;
            }
        }
    }

    public void executeAppUnderTestImpl(Class<? extends AppUnderTest> appUnderTestClass,
            String threadName) throws IOException, ClassNotFoundException {

        objectOut.writeObject(SocketCommandProcessor.EXECUTE_APP_COMMAND);
        objectOut.writeObject(appUnderTestClass.getName());
        objectOut.writeObject(threadName);
        getNextNonPingValue();
    }

    public void shutdownImpl() throws IOException, InterruptedException {
        objectOut.close();
        objectIn.close();
        socket.close();
        process.waitFor();
        executorService.shutdownNow();
    }

    public static void main(String[] args) {
        try {
            int port = Integer.parseInt(args[0]);
            Socket socket = new Socket((String) null, port);
            ObjectInputStream objectIn = new ObjectInputStream(socket.getInputStream());
            ObjectOutputStream objectOut = new ObjectOutputStream(socket.getOutputStream());
            new Thread(new SocketCommandProcessor(objectIn, objectOut)).start();
            new Thread(new SocketHeartbeat(objectOut)).start();
        } catch (Throwable t) {
            // log error and exit gracefully
            logger.error(t.getMessage(), t);
        }
    }

    private static String findInformantCoreJarPath(String classpath) {
        String[] classpathElements = classpath.split(File.pathSeparator);
        for (String classpathElement : classpathElements) {
            if (new File(classpathElement).getName().matches(
                    "informant-core-[0-9.]+(-SNAPSHOT)?.jar")) {
                return classpathElement;
            }
        }
        throw new IllegalStateException("Unable to find informant-core.jar on the classpath: "
                + classpath);
    }
}
