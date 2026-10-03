// Synthetic correspondences test the solver, not real corner detection or camera accuracy.
#include <opencv2/core.hpp>
#if CV_VERSION_MAJOR >= 5
#include <opencv2/calib.hpp>
#include <opencv2/geometry.hpp>
#else
#include <opencv2/calib3d.hpp>
#endif
#include <algorithm>
#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

int main(int argc, char** argv) {
    try {
        const bool degenerate = argc == 2 && std::string(argv[1]) == "--degenerate";
        if (argc > 2 || (argc == 2 && !degenerate))
            throw std::runtime_error("usage: camera_calibration [--degenerate]");
        const cv::Size size(1280, 960);
        const cv::Mat truthK(cv::Matx33d(900, 0, 640, 0, 880, 480, 0, 0, 1));
        const cv::Mat truthD(cv::Matx<double, 1, 5>(-0.12, 0.03, 0.001, -0.001, 0.0));
        std::vector<cv::Point3f> board;
        for (int y = 0; y < 6; ++y)
            for (int x = 0; x < 9; ++x)
                board.emplace_back((x - 4)*25.0f, (y - 2.5f)*25.0f, 0.0f);
        std::vector<std::vector<cv::Point3f>> objectPoints;
        std::vector<std::vector<cv::Point2f>> imagePoints;
        std::vector<cv::Vec3d> rotations;
        for (int i = 0; i < 15; ++i) {
            const cv::Vec3d r = degenerate ? cv::Vec3d(0, 0, 0) :
                cv::Vec3d(0.35*std::sin(i*0.7), 0.4*std::cos(i*0.5), 0.12*i);
            const cv::Vec3d t = degenerate ? cv::Vec3d(0, 0, 700) :
                cv::Vec3d(100*std::sin(i*0.9), 70*std::cos(i*0.6), 600 + 15*i);
            std::vector<cv::Point2f> points;
            cv::projectPoints(board, r, t, truthK, truthD, points);
            if (std::any_of(points.begin(), points.end(), [&](cv::Point2f p) {
                return p.x < 0 || p.y < 0 || p.x >= size.width || p.y >= size.height;
            })) throw std::runtime_error("synthetic board outside image");
            objectPoints.push_back(board);
            imagePoints.push_back(points);
            rotations.push_back(r);
        }
        // This uses known synthetic poses; real capture needs coverage/conditioning checks.
        double diversity = 0;
        for (const auto& r : rotations)
            diversity = std::max(diversity, cv::norm(r - rotations.front()));
        if (diversity < 0.1)
            throw std::runtime_error("rejected: repeated/front-facing synthetic poses");
        cv::Mat K, D;
        std::vector<cv::Mat> rvecs, tvecs;
        const double rms = cv::calibrateCamera(objectPoints, imagePoints, size,
            K, D, rvecs, tvecs, 0,
            cv::TermCriteria(cv::TermCriteria::COUNT | cv::TermCriteria::EPS, 100, 1e-12));
        double sumSquared = 0;
        std::size_t total = 0;
        for (std::size_t i = 0; i < objectPoints.size(); ++i) {
            std::vector<cv::Point2f> projected;
            cv::projectPoints(objectPoints[i], rvecs[i], tvecs[i], K, D, projected);
            const double error = cv::norm(projected, imagePoints[i], cv::NORM_L2);
            sumSquared += error*error;
            total += projected.size();
        }
        const double checkedRms = std::sqrt(sumSquared / total);
        const double relativeK = cv::norm(K, truthK, cv::NORM_L2) / cv::norm(truthK);
        if (!cv::checkRange(K) || !cv::checkRange(D) || !std::isfinite(rms)
            || !std::isfinite(checkedRms) || checkedRms > 1e-3 || relativeK > 1e-3)
            throw std::runtime_error("synthetic calibration recovery failed");
        std::cout << "OpenCV " << CV_VERSION << "\nK=\n" << K
                  << "\nD=" << D << "\nsolver RMS=" << rms
                  << " px\nchecked RMS=" << checkedRms
                  << " px\nrelative K error=" << relativeK << '\n';
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
